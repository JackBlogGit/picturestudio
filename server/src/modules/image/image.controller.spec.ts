import { CanActivate, ExecutionContext, HttpStatus, INestApplication, StreamableFile, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ActorRequest } from '../../common/auth/actor.guard';
import { AdminGuard, PermissionGuard } from '../../common/auth/permission.guard';
import { ResourceLoader } from '../../common/permission/resource-loader';
import { Actor, ActorKind, ResourceRef, ResourceType } from '../../common/permission/types';
import { UserLevel } from '../../common/enums/user-level.enum';
import { Visibility } from '../../common/enums/visibility.enum';
import { AllExceptionsFilter } from '../../common/http/app-error';
import { ResponseEnvelopeInterceptor } from '../../common/http/response-envelope.interceptor';
import { AuditService } from '../audit/audit.service';
import { ImageService } from './image.service';
import { ImageController } from './image.controller';

/**
 * 这一层不碰 TypeORM：只验证「守卫 → 路由 → 校验管道 → 字节出口」这条链在真实 HTTP 上成立，
 * 也就是 PRD M2 验收口径里的「预览接口无越权」。身份由测试头注入，替代 ActorGuard 的 JWT 解析。
 */
const ALBUM_ID = 1;
const PUBLIC_IMG = 11;
const MEMBER_IMG = 12;
const PRIVATE_IMG = 13;

function ref(over: Partial<ResourceRef>): ResourceRef {
  return {
    type: ResourceType.Image,
    id: PUBLIC_IMG,
    visibility: Visibility.Public,
    ownerId: 100,
    albumId: ALBUM_ID,
    uploadTempId: null,
    containerVisibilities: [Visibility.Public],
    ...over,
  };
}

const RESOURCES = new Map<number, ResourceRef>([
  [ALBUM_ID, ref({ type: ResourceType.Album, containerVisibilities: [] })],
  [PUBLIC_IMG, ref({})],
  [MEMBER_IMG, ref({ id: MEMBER_IMG, visibility: Visibility.Member, containerVisibilities: [Visibility.Member] })],
  [PRIVATE_IMG, ref({ id: PRIVATE_IMG, visibility: Visibility.Private, ownerId: 200, containerVisibilities: [Visibility.Private] })],
]);

const ACTORS: Record<string, Actor> = {
  guest: { kind: ActorKind.Guest },
  trainee1: { kind: ActorKind.Member, uid: 100, level: UserLevel.Trainee },
  member2: { kind: ActorKind.Member, uid: 100, level: UserLevel.Member },
  admin3: { kind: ActorKind.Member, uid: 100, level: UserLevel.Admin },
  superAdmin4: { kind: ActorKind.Member, uid: 200, level: UserLevel.SuperAdmin },
};

class TestActorGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ActorRequest>();
    const key = String(req.headers['x-test-actor'] ?? 'guest');
    req.actor = ACTORS[key] ?? ACTORS.guest;
    req.auditCtx = { ip: '203.0.113.7', ua: 'jest-e2e' };
    return true;
  }
}

const spies = {
  listInAlbum: jest.fn(async (_albumId: number, query: { tags?: number[] }) => ({
    page: 1,
    pageSize: 20,
    total: 1,
    list: [{ id: PUBLIC_IMG, echoedTags: query.tags ?? [] }],
  })),
  preview: jest.fn(
    async (id: number) => new StreamableFile(Buffer.from(`preview-bytes-${id}`), { type: 'image/webp' }),
  ),
  original: jest.fn(
    async (id: number) =>
      new StreamableFile(Buffer.from(`original-bytes-${id}`), {
        type: 'application/octet-stream',
        disposition: 'attachment; filename="a.jpg"',
      }),
  ),
  update: jest.fn(async (id: number) => ({ id })),
  batchTags: jest.fn(async () => ({ requested: 1, updated: 1, rejected: [] })),
  batchVisibility: jest.fn(async () => ({ requested: 1, updated: 1, rejected: [] })),
};

const auditRecord = jest.fn(async () => undefined);

describe('图片接口越权链路（真实 HTTP）', () => {
  let app: INestApplication;
  let http: () => ReturnType<typeof request>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ImageController],
      providers: [
        { provide: ImageService, useValue: spies },
        {
          provide: ResourceLoader,
          useValue: { load: async (_t: ResourceType, id: number) => RESOURCES.get(id) ?? null },
        },
        { provide: AuditService, useValue: { record: auditRecord } },
        Reflector,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    const reflector = app.get(Reflector);
    const loader = app.get(ResourceLoader);
    const audit = app.get(AuditService);
    app.useGlobalGuards(new TestActorGuard(), new AdminGuard(reflector, audit), new PermissionGuard(reflector, loader, audit));
    app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    http = () => request(app.getHttpServer());
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('预览出口是裸字节，不会被包成 JSON 信封', async () => {
    const res = await http().get(`/api/v1/images/${PUBLIC_IMG}/preview`).expect(HttpStatus.OK);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['content-type']).not.toContain('application/json');
    expect(res.body).not.toHaveProperty('code');
    expect(spies.preview).toHaveBeenCalledWith(PUBLIC_IMG);
  });

  it('游客请求成员档图片预览 → 404，并落一条 result=0 的越权审计（PRD 15.4）', async () => {
    const res = await http()
      .get(`/api/v1/images/${MEMBER_IMG}/preview`)
      .set('x-test-actor', 'guest')
      .expect(HttpStatus.NOT_FOUND);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(spies.preview).not.toHaveBeenCalled();
    expect(auditRecord).toHaveBeenCalledWith(
      ACTORS.guest,
      expect.objectContaining({ ip: '203.0.113.7' }),
      expect.objectContaining({ action: 'preview_denied', result: 0 }),
    );
  });

  it('游客可以预览 public 图的字节，但下载原图 403（PRD 15.1）', async () => {
    await http().get(`/api/v1/images/${PUBLIC_IMG}/preview`).expect(HttpStatus.OK);
    const res = await http().get(`/api/v1/images/${PUBLIC_IMG}/original`).expect(HttpStatus.FORBIDDEN);
    expect(res.body).toMatchObject({ code: 'GUEST_FORBIDDEN' });
    expect(spies.original).not.toHaveBeenCalled();
  });

  it('下载原图：L2 放行，L1 被档位矩阵拒绝（PRD 15.2）', async () => {
    await http()
      .get(`/api/v1/images/${PUBLIC_IMG}/original`)
      .set('x-test-actor', 'member2')
      .expect(HttpStatus.OK);
    const res = await http()
      .get(`/api/v1/images/${PUBLIC_IMG}/original`)
      .set('x-test-actor', 'trainee1')
      .expect(HttpStatus.FORBIDDEN);
    expect(res.body).toMatchObject({ code: 'LEVEL_FORBIDDEN' });
  });

  it('他人 private 图：L3 404，本人 L4 200（PRD 15.4，D1）', async () => {
    await http()
      .get(`/api/v1/images/${PRIVATE_IMG}/preview`)
      .set('x-test-actor', 'admin3')
      .expect(HttpStatus.NOT_FOUND);
    await http()
      .get(`/api/v1/images/${PRIVATE_IMG}/preview`)
      .set('x-test-actor', 'superAdmin4')
      .expect(HttpStatus.OK);
  });

  it('批量路由不能被 :id 抢走，PATCH /images/batch-visibility 落在批量处理上', async () => {
    const res = await http()
      .patch('/api/v1/images/batch-visibility')
      .send({ imageIds: [PUBLIC_IMG], visibility: Visibility.Member })
      .expect(HttpStatus.OK);
    expect(spies.batchVisibility).toHaveBeenCalledTimes(1);
    expect(spies.update).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ code: 'OK', data: { requested: 1, updated: 1 } });
  });

  it('批量打标返回 200 而不是 201', async () => {
    await http()
      .post('/api/v1/images/batch-tags')
      .send({ imageIds: [PUBLIC_IMG], add: [1] })
      .expect(HttpStatus.OK);
    expect(spies.batchTags).toHaveBeenCalledTimes(1);
  });

  it('批量改档位漏传 visibility 时 400，不带着半截参数进服务层', async () => {
    const res = await http()
      .patch('/api/v1/images/batch-visibility')
      .send({ imageIds: [PUBLIC_IMG] })
      .expect(HttpStatus.BAD_REQUEST);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(spies.batchVisibility).not.toHaveBeenCalled();
  });

  it('路径参数不是数字 → 守卫先给出 404，不落到管道也不查库（PRD 12.5）', async () => {
    const res = await http().get('/api/v1/images/abc/preview').expect(HttpStatus.NOT_FOUND);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(spies.preview).not.toHaveBeenCalled();
  });

  it('筛选参数：逗号标签解析成数字数组，超上限的 pageSize 被管道拒绝', async () => {
    const res = await http()
      .get(`/api/v1/albums/${ALBUM_ID}/images?tags=1,2&status=&page=1`)
      .set('x-test-actor', 'member2')
      .expect(HttpStatus.OK);
    expect(res.body.data.list[0].echoedTags).toEqual([1, 2]);
    expect(spies.listInAlbum).toHaveBeenCalledWith(ALBUM_ID, expect.objectContaining({ tags: [1, 2] }), ACTORS.member2);

    await http()
      .get(`/api/v1/albums/${ALBUM_ID}/images?pageSize=999`)
      .expect(HttpStatus.BAD_REQUEST);
  });

  it('未标注权限元数据的路由不由 PermissionGuard 查库', async () => {
    await http()
      .post('/api/v1/images/batch-tags')
      .send({ imageIds: [PUBLIC_IMG], remove: [3] })
      .expect(HttpStatus.OK);
    expect(auditRecord).not.toHaveBeenCalled();
  });
});

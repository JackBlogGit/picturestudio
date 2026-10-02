import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { TASK_STAGE_FILTER_VALUES, TaskStageFilter } from '../../../common/permission/task-policy';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** PRD 17.3：排序字段只认这三列，别把实体名透出去 */
export const TASK_SORT_FIELDS = ['create_time', 'pre_done_time', 'post_done_time'] as const;
export type TaskSortField = (typeof TASK_SORT_FIELDS)[number];

/** 前端列名 → 查询别名.属性名，映射表本身即白名单 */
export const TASK_SORT_COLUMNS: Record<TaskSortField, string> = {
  create_time: 't.createTime',
  pre_done_time: 't.preDoneTime',
  post_done_time: 't.postDoneTime',
};

export class ListTaskDto {
  /** 缺省 = 不加阶段条件，对应徽标里的「总数」口径 */
  @IsOptional()
  @IsIn(TASK_STAGE_FILTER_VALUES, {
    message: `stage 只能是 ${TASK_STAGE_FILTER_VALUES.join(' / ')}`,
  })
  stage?: TaskStageFilter;

  /** 帐户ID / 登录名 / 昵称的前缀，服务内要求 ≥2 字符才发查询 */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  q?: string;

  @IsOptional()
  @IsIn(TASK_SORT_FIELDS, { message: '排序字段不合法' })
  by?: TaskSortField;

  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'sort 只能是 asc / desc' })
  sort?: 'asc' | 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}

export class UpdateTaskStageDto {
  @IsIn(['pre', 'post'], { message: 'stage 只能是 pre / post' })
  stage: 'pre' | 'post';

  /** 完成时间由服务端盖章，前端只能表达「完成 / 未完成」两态 */
  @IsIn([0, 1], { message: 'status 只能是 0 / 1' })
  status: 0 | 1;

  /** 回退时必填，存在性在服务内校验（PRD 17.2 第 2 点） */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200, { message: '回退原因不得超过 200 字' })
  reason?: string;
}

/** 注销不可逆（D11），必须显式二次确认 */
export class RevokeTaskDto {
  @IsIn([true], { message: '注销工单需显式确认（confirm=true）' })
  confirm: boolean;
}

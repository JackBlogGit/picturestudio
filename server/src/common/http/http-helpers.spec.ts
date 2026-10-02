import { contentDisposition } from './disposition';
import { clampPaging, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, pagedList } from './pagination';

describe('contentDisposition：中文文件名与注入', () => {
  it('双写 filename 与 filename*，中文走 RFC 5987 才不乱码', () => {
    const header = contentDisposition('春日部透子 返图.jpg');
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('春日部透子 返图.jpg')}`);
    // 老浏览器只认 ASCII 那一份：汉字换成下划线，空格原样保留
    expect(header).toContain('filename="_____ __.jpg"');
  });

  it('扩展名尽量留在 ASCII 那份里', () => {
    expect(contentDisposition('照片.webp')).toContain('filename="__.webp"');
    expect(contentDisposition('photo.jpg')).toContain('filename="photo.jpg"');
  });

  it('响应头注入：换行、引号、分号全部剔除', () => {
    const evil = 'a.jpg\r\nX-Attack: 1';
    const header = contentDisposition(evil);
    expect(header).not.toContain('\r');
    expect(header).not.toContain('\n');
    expect(header.split(';').length).toBe(3);
    expect(contentDisposition('b"; filename=admin.zip').split(';')).toHaveLength(3);
  });

  it('空文件名兜底成 download，inline 档位用于预览', () => {
    expect(contentDisposition('')).toBe(`attachment; filename="download"; filename*=UTF-8''download`);
    expect(contentDisposition('   ', 'inline')).toContain('inline;');
  });
});

describe('分页参数收敛', () => {
  it('缺省用默认页大小', () => {
    expect(clampPaging()).toEqual({ skip: 0, take: DEFAULT_PAGE_SIZE, page: 1, pageSize: DEFAULT_PAGE_SIZE });
  });

  it('越界与脏值一律收敛而不报错', () => {
    expect(clampPaging({ page: 0, pageSize: 0 }).page).toBe(1);
    expect(clampPaging({ page: -5 }).skip).toBe(0);
    expect(clampPaging({ pageSize: 99999 }).pageSize).toBe(MAX_PAGE_SIZE);
    expect(clampPaging({ page: 3.7, pageSize: 12.9 })).toEqual({ skip: 24, take: 12, page: 3, pageSize: 12 });
    expect(clampPaging({ page: Number.NaN }).page).toBe(1);
    expect(clampPaging({ pageSize: Number.NaN }).pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it('skip 跟着收敛后的值算，别让负数进 SQL', () => {
    expect(clampPaging({ page: 4, pageSize: 20 }).skip).toBe(60);
    expect(clampPaging({ page: 2, pageSize: MAX_PAGE_SIZE }).skip).toBe(100);
  });

  it('统一分页结构 { page, pageSize, total, list }', () => {
    expect(pagedList(['a'], 1)).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE, total: 1, list: ['a'] });
    expect(pagedList<number[]>([], 0, 3, 50)).toEqual({ page: 3, pageSize: 50, total: 0, list: [] });
  });
});

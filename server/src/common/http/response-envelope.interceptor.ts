import { CallHandler, ExecutionContext, NestInterceptor, StreamableFile } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiBody<T = unknown> {
  code: string;
  message: string;
  data: T;
  traceId: string;
}

/** 成功响应统一包成 {code,message,data,traceId}，异常由 AllExceptionsFilter 负责 */
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<T, ApiBody<T> | T> {
  intercept(_ctx: ExecutionContext, next: CallHandler<T>): Observable<ApiBody<T> | T> {
    return next.handle().pipe(
      map((data) =>
        // 字节出口（预览/原图）必须是裸流，包一层 JSON 就没法 pipe 了
        data instanceof StreamableFile ? data : { code: 'OK', message: '成功', data, traceId: '' },
      ),
    );
  }
}

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

export class AppError extends HttpException {
  readonly code: string;
  /** 少数业务错误必须带上下文（409 查重附已存图片链接、批量改档位附不合规清单） */
  readonly data: unknown;

  constructor(status: HttpStatus, code: string, message: string, data: unknown = null) {
    super(message, status);
    this.code = code;
    this.data = data;
  }
}

interface Body {
  code: string;
  message: string;
  data: unknown;
  traceId: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const traceId = randomUUID();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = '服务器内部错误';
    let data: unknown = null;

    if (exception instanceof AppError) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      data = exception.data;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      message =
        typeof payload === 'string'
          ? payload
          : Array.isArray((payload as { message?: string[] }).message)
            ? (payload as { message: string[] }).message.join('；')
            : ((payload as { message?: string }).message ?? exception.message);
      code = status === HttpStatus.BAD_REQUEST ? 'VALIDATION_FAILED' : 'HTTP_ERROR';
    } else if (process.env.NODE_ENV !== 'production') {
      message = exception instanceof Error ? exception.message : String(exception);
    }

    // 未知异常必须留全栈；已知业务异常只记一行，避免日志被越权探测刷满
    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`${req.method} ${req.url} trace=${traceId}`, exception as Error);
    } else {
      this.logger.warn(`${req.method} ${req.url} ${status} ${code} trace=${traceId}`);
    }

    const body: Body = { code, message, data, traceId };
    res.status(status).json(body);
  }
}

export function ok<T>(data: T): Body {
  return { code: 'OK', message: '成功', data, traceId: '' };
}

import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const response = context.getResponse<{ status: (statusCode: number) => { json: (body: unknown) => void } }>();
    const request = context.getRequest<{ url?: string }>();
    const statusCode = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const normalized = this.normalizeException(exception, statusCode);

    response.status(statusCode).json({
      statusCode,
      message: normalized.message,
      error: normalized.error,
      ...(normalized.code ? { code: normalized.code } : {}),
      path: request.url ?? '',
      timestamp: new Date().toISOString(),
    });
  }

  private normalizeException(exception: unknown, statusCode: number) {
    if (!(exception instanceof HttpException)) {
      return {
        message: 'Internal server error',
        error: 'Internal Server Error',
        code: undefined,
      };
    }

    const payload = exception.getResponse();

    if (typeof payload === 'string') {
      return {
        message: payload,
        error: exception.name,
        code: undefined,
      };
    }

    if (typeof payload === 'object' && payload !== null) {
      const body = payload as { message?: unknown; error?: unknown };
      return {
        message: this.normalizeMessage(body.message) ?? exception.message,
        error: typeof body.error === 'string' ? body.error : this.defaultError(statusCode),
        code: typeof (body as { code?: unknown }).code === 'string' ? (body as { code: string }).code : undefined,
      };
    }

    return {
      message: exception.message,
      error: this.defaultError(statusCode),
      code: undefined,
    };
  }

  private normalizeMessage(message: unknown) {
    if (typeof message === 'string') return message;
    if (Array.isArray(message) && message.every((item) => typeof item === 'string')) return message;
    return null;
  }

  private defaultError(statusCode: number) {
    if (statusCode === HttpStatus.BAD_REQUEST) return 'Bad Request';
    if (statusCode === HttpStatus.UNAUTHORIZED) return 'Unauthorized';
    if (statusCode === HttpStatus.FORBIDDEN) return 'Forbidden';
    if (statusCode === HttpStatus.NOT_FOUND) return 'Not Found';
    if (statusCode === HttpStatus.CONFLICT) return 'Conflict';
    if (statusCode === HttpStatus.TOO_MANY_REQUESTS) return 'Too Many Requests';
    return 'Error';
  }
}

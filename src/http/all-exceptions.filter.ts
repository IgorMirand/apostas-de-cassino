import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import { mapError } from './error-mapper';

/** Resposta mínima (estrutural): o projeto não depende dos tipos do Express. */
interface HttpResponseLike {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const mapped = mapError(exception);
    if (mapped.logLevel === 'error') {
      this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    } else if (mapped.logLevel === 'warn') {
      this.logger.warn(exception instanceof Error ? exception.message : String(exception));
    }
    const res = host.switchToHttp().getResponse<HttpResponseLike>();
    for (const [name, value] of Object.entries(mapped.headers)) res.setHeader(name, value);
    res.status(mapped.status);
    res.json(mapped.body);
  }
}
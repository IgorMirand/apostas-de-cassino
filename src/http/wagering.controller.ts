import { Body, Controller, Headers, Inject, Post, Res } from '@nestjs/common';
import { parseSubmitTransactionCommand } from '../application/commands';
import { InvalidRequestError } from '../application/errors';
import {
  ProcessWagerTransactionUseCase, type TransactionResult,
} from '../application/process-wager-transaction.use-case';
import { WagerTransactionStatus } from '../domain/wager-transaction';

interface StatusSetter {
  status(code: number): unknown;
}

/**
 * Status HTTP da resposta de uma transação:
 *   201  processada agora            200  replay de uma processada
 *   422  rejeitada por regra de negócio (também no replay: o resultado ORIGINAL é devolvido)
 *   202  aceita, aguardando a referência (PENDING_REFERENCE)
 */
export function statusFor(result: TransactionResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.PendingReference:
      return 202;
    default:
      return 500; // PENDING/FAILED nunca deveriam chegar à resposta
  }
}

@Controller('wagering')
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase) private readonly processTransaction: ProcessWagerTransactionUseCase,
  ) {}

  @Post('transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: StatusSetter,
  ): Promise<TransactionResult> {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      throw new InvalidRequestError(['Idempotency-Key header is required']);
    }
    // O HEADER é a única fonte da chave: um `idempotencyKey` no corpo é descartado.
    const raw = body !== null && typeof body === 'object' && !Array.isArray(body) ? { ...body, idempotencyKey } : body;

    const result = await this.processTransaction.execute(parseSubmitTransactionCommand(raw));
    res.status(statusFor(result));
    return result;
  }
}
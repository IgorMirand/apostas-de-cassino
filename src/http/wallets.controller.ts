import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { isUuid, parseCreateWalletCommand } from '../application/commands';
import { CreateWalletUseCase, type WalletView } from '../application/create-wallet.use-case';
import { WalletNotFoundError } from '../application/errors';
import { GetWalletUseCase } from '../application/get-wallet.use-case';

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(GetWalletUseCase) private readonly getWallet: GetWalletUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown): Promise<WalletView> {
    return this.createWallet.execute(parseCreateWalletCommand(body));
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<WalletView> {
    // um id que nem é UUID não pode existir: 404, e o Postgres nunca vê um uuid inválido
    if (!isUuid(id)) throw new WalletNotFoundError(id);
    return this.getWallet.execute(id);
  }
}
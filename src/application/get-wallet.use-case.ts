import { WalletNotFoundError } from './errors';
import { toWalletView, type WalletView } from './create-wallet.use-case';
import type { UnitOfWork } from './ports';

export class GetWalletUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.run((repos) => repos.wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(walletId);
    return toWalletView(wallet);
  }
}
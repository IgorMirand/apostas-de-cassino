/** Erro de PROGRAMAÇÃO na camada de persistência (não é regra de negócio). */
export class WalletNotLockedError extends Error {
  constructor(walletId: string) {
    super(`wallet ${walletId} must be loaded with findByIdForUpdate in this transaction before save()`);
    this.name = 'WalletNotLockedError';
  }
}
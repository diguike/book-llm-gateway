// CLI: 给已有 user 创建 wallet 并初始化余额.
//
// 主要给「v0.10 之前已存在的 user」补 wallet 用. v0.11 新建 user 时, admin/users 路由
// 会自动 ensureWallet, 不需要再手动跑这个.
//
// 用法:
//   npx tsx src/cli/seed-wallet.ts --user-id 1 --balance-cny 100
//   npx tsx src/cli/seed-wallet.ts --all              # 给所有 user 都建 wallet
//                                                       (从 users.balance_micro 复制初始余额)

import 'dotenv/config';
import { eq } from 'drizzle-orm';

import { runMigrations } from '../db/migrate.js';
import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { ensureWallet, getWalletByUserId } from '../wallet/service.js';

interface Args {
  userId?: number;
  balanceCny?: number;
  all?: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user-id' && argv[i + 1]) {
      args.userId = Number(argv[i + 1]);
      i++;
    } else if (a === '--balance-cny' && argv[i + 1]) {
      args.balanceCny = Number(argv[i + 1]);
      i++;
    } else if (a === '--all') {
      args.all = true;
    }
  }
  return args;
}

function seedOne(userId: number, initialBalanceMicro: number): void {
  const before = getWalletByUserId(userId);
  const wallet = ensureWallet({ userId, initialBalanceMicro });
  const verb = before ? 'exists' : 'created';
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      verb,
      userId,
      walletId: wallet.id,
      balanceMicro: wallet.balanceMicro,
      balanceCny: wallet.balanceMicro / 1_000_000,
    }),
  );
}

function main(): void {
  runMigrations();
  const args = parseArgs(process.argv.slice(2));

  if (args.all) {
    const db = getDb();
    const allUsers = db.select().from(users).all();
    let n = 0;
    for (const u of allUsers) {
      seedOne(u.id, u.balanceMicro);
      n++;
    }
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ summary: `seeded ${n} wallets` }));
    return;
  }

  if (typeof args.userId !== 'number' || Number.isNaN(args.userId)) {
    // eslint-disable-next-line no-console
    console.error('usage: seed-wallet --user-id <id> [--balance-cny <n>] | --all');
    process.exit(1);
  }
  const db = getDb();
  const u = db.select().from(users).where(eq(users.id, args.userId)).all();
  if (u.length === 0) {
    // eslint-disable-next-line no-console
    console.error(`user ${args.userId} not found`);
    process.exit(2);
  }
  const initialMicro =
    args.balanceCny !== undefined
      ? Math.round(args.balanceCny * 1_000_000)
      : u[0]!.balanceMicro;
  seedOne(args.userId, initialMicro);
}

main();

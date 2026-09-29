import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "@/env";
import { PrismaClient } from "@/generated/prisma/client";
import { encryptedTokens } from "@/utils/prisma-extensions";
import { auditPrismaQueries } from "@/utils/audit/prisma-extension";

declare global {
  var prisma: PrismaClient | undefined;
  var prismaClientClass: typeof PrismaClient | undefined;
}

// In development the client lives on `global` so hot reloads share one connection pool.
// `prisma generate` reloads the generated module with a new PrismaClient class, so a
// different class means the schema changed and the cached client must be replaced.
const cachedClientIsCurrent = global.prismaClientClass === PrismaClient;
if (global.prisma && !cachedClientIsCurrent) {
  global.prisma.$disconnect().catch(() => undefined);
}

// Create the Prisma client with extensions, but cast it back to PrismaClient for type compatibility
const _prisma =
  (cachedClientIsCurrent && global.prisma) ||
  (new PrismaClient({
    adapter: new PrismaPg({
      connectionString: env.PREVIEW_DATABASE_URL ?? env.DATABASE_URL,
    }),
  })
    .$extends(encryptedTokens)
    .$extends(auditPrismaQueries) as unknown as PrismaClient);

if (env.NODE_ENV === "development") {
  global.prisma = _prisma;
  global.prismaClientClass = PrismaClient;
}

export default _prisma;

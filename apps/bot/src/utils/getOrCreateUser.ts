import { db } from "@sp3ndly/database";

export async function getOrCreateUser(telegramId: string) {
  return db.user.upsert({
    where: { telegramId },
    update: {},
    create: { telegramId },
  });
}
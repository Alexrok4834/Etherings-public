import 'reflect-metadata';
import path from 'node:path';
import { DataSource } from 'typeorm';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for migration commands');
}

export default new DataSource({
  type: 'postgres',
  url: databaseUrl,
  synchronize: false,
  migrationsRun: false,
  entities: [path.join(__dirname, '..', '**', '*.entity.{js,ts}')],
  migrations: [path.join(__dirname, '..', 'migrations', '*.{js,ts}')],
});

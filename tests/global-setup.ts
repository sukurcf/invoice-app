import type { TestProject } from "vitest/node";
import { startTestDatabase } from "./database.js";

export default async function setup(project: TestProject) {
  const database = await startTestDatabase();
  project.provide("databaseUrl", database.url);
  return database.stop;
}

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

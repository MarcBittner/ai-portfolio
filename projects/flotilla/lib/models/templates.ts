import { z } from "zod";
import { col, newId, now, NO_ID } from "./base.ts";

// A reproducible instance recipe (plan O4 / B-8): branch + backup + clerk + env,
// redeployable N times.
export const NewTemplate = z.object({
  name: z.string().min(1).max(120),
  branch: z.string().min(1).max(200),
  backupRef: z.string().min(1).max(200),
  clerkInstance: z.string().max(120).optional(),
  env: z.record(z.string(), z.string()).optional(),
  migrations: z.boolean().default(true),
  scrubPII: z.boolean().default(true),
});
export type NewTemplate = z.infer<typeof NewTemplate>;

export type TemplateDoc = {
  id: string;
  name: string;
  branch: string;
  backupRef: string;
  clerkInstance?: string;
  env?: Record<string, string>;
  migrations: boolean;
  scrubPII: boolean;
  createdAt: number;
  updatedAt: number;
};

export async function listTemplates(): Promise<TemplateDoc[]> {
  const c = await col<TemplateDoc>("templates");
  return c.find({}, NO_ID).sort({ createdAt: -1 }).toArray();
}

export async function getTemplate(id: string): Promise<TemplateDoc | null> {
  const c = await col<TemplateDoc>("templates");
  return c.findOne({ id }, NO_ID);
}

export async function createTemplate(input: NewTemplate): Promise<TemplateDoc> {
  const parsed = NewTemplate.parse(input);
  const ts = now();
  const doc: TemplateDoc = {
    id: newId("tpl"),
    ...parsed,
    createdAt: ts,
    updatedAt: ts,
  };
  const c = await col<TemplateDoc>("templates");
  await c.insertOne(doc);
  return doc;
}

export async function deleteTemplate(id: string): Promise<void> {
  const c = await col<TemplateDoc>("templates");
  await c.deleteOne({ id });
}

/**
 * Zod schemas for the Foxglove WebSocket server→client text message ops.
 *
 * The WebSocket delivers each server-originated control message as JSON; we
 * validate the shape at the transport edge so the rest of the adapter can
 * work with properly typed values and never needs a type assertion to move
 * from `unknown` to a domain shape.
 *
 * Protocol spec: https://github.com/foxglove/ws-protocol/blob/main/docs/spec.md
 */

import { z } from "zod";

const channelSchema = z.object({
  id: z.number(),
  topic: z.string(),
  encoding: z.string(),
  schemaName: z.string(),
  schema: z.string(),
  schemaEncoding: z.string().optional()
});

const serviceSchemaSide = z.object({
  encoding: z.string().optional(),
  schemaName: z.string().optional(),
  schemaEncoding: z.string().optional(),
  schema: z.string()
});

const serviceSchema = z.object({
  id: z.number(),
  name: z.string(),
  type: z.string(),
  // Legacy flat form (foxglove.websocket.v1 bridges).
  requestSchema: z.string().optional(),
  responseSchema: z.string().optional(),
  // foxglove.sdk.v1 nested form.
  request: serviceSchemaSide.optional(),
  response: serviceSchemaSide.optional()
});

const parameterValueSchema = z.object({
  name: z.string(),
  value: z.unknown(),
  type: z.string().optional()
});

const serverInfoMessageSchema = z.object({
  op: z.literal("serverInfo"),
  name: z.string(),
  capabilities: z.array(z.string()),
  supportedEncodings: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  sessionId: z.string().optional()
});

const advertiseMessageSchema = z.object({
  op: z.literal("advertise"),
  channels: z.array(channelSchema)
});

const unadvertiseMessageSchema = z.object({
  op: z.literal("unadvertise"),
  channelIds: z.array(z.number())
});

const advertiseServicesMessageSchema = z.object({
  op: z.literal("advertiseServices"),
  services: z.array(serviceSchema)
});

const unadvertiseServicesMessageSchema = z.object({
  op: z.literal("unadvertiseServices"),
  serviceIds: z.array(z.number())
});

const parameterValuesMessageSchema = z.object({
  op: z.literal("parameterValues"),
  id: z.string().optional(),
  parameters: z.array(parameterValueSchema)
});

const statusMessageSchema = z.object({
  op: z.literal("status"),
  level: z.number(),
  message: z.string().optional(),
  msg: z.string().optional()
});

/**
 * Discriminated union of every server→client text message we handle. Any
 * other `op` the server sends is tolerated silently (parsed as the `ignored`
 * variant) rather than erroring — future protocol additions shouldn't break
 * the session.
 */
export const serverMessageSchema = z.discriminatedUnion("op", [
  serverInfoMessageSchema,
  advertiseMessageSchema,
  unadvertiseMessageSchema,
  advertiseServicesMessageSchema,
  unadvertiseServicesMessageSchema,
  parameterValuesMessageSchema,
  statusMessageSchema
]);

/**
 * Service class — drop-in replacement for roslib's ROSLIB.Service.
 *
 * Provides callService matching the roslib API. Service calls go through the
 * foxglove WebSocket protocol. Client-side service advertisement is not
 * supported by foxglove_bridge, and the corresponding no-op shims have been
 * removed now that no caller depends on them.
 */

import type { z } from "zod";

import { Ros } from "./ros";

type ServiceResponseCallback<T = unknown> = {
  bivarianceHack(response: T): void;
}["bivarianceHack"];

export interface ServiceOptions<TResp = unknown> {
  ros: Ros;
  name: string;
  serviceType: string;
  /**
   * Optional runtime validator for decoded responses. When supplied, success
   * callbacks receive only values that have passed this schema.
   */
  responseSchema?: z.ZodType<TResp>;
}

export class Service<TReq = unknown, TResp = unknown> {
  ros: Ros;
  name: string;
  serviceType: string;
  private readonly responseSchema: z.ZodType<TResp> | undefined;

  constructor(options: ServiceOptions<TResp>) {
    this.ros = options.ros;
    this.name = options.name;
    this.serviceType = options.serviceType;
    this.responseSchema = options.responseSchema;
  }

  /**
   * Call the service (roslib-compatible callback API).
   */
  callService(
    request: TReq,
    onSuccess?: ServiceResponseCallback<TResp>,
    onError?: (error: string) => void
  ): void {
    const responseSchema = this.responseSchema;
    const deliver: ServiceResponseCallback | undefined =
      onSuccess && responseSchema
        ? (response) => onSuccess(responseSchema.parse(response))
        : onSuccess;

    this.ros
      .callService(this.name, this.serviceType, request)
      .then((response) => deliver?.(response))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        onError?.(msg);
      });
  }
}

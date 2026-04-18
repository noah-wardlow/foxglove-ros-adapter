/**
 * Service class — drop-in replacement for roslib's ROSLIB.Service.
 *
 * Provides callService matching the roslib API. Service calls go through the
 * foxglove WebSocket protocol. Client-side service advertisement is not
 * supported by foxglove_bridge, and the corresponding no-op shims have been
 * removed now that no caller depends on them.
 */

import { Ros } from "./ros";

export interface ServiceOptions {
  ros: Ros;
  name: string;
  serviceType: string;
}

export class Service<TReq = unknown, TResp = unknown> {
  ros: Ros;
  name: string;
  serviceType: string;

  constructor(options: ServiceOptions) {
    this.ros = options.ros;
    this.name = options.name;
    this.serviceType = options.serviceType;
  }

  /**
   * Call the service (roslib-compatible callback API).
   */
  callService(
    request: TReq,
    onSuccess?: (response: TResp) => void,
    onError?: (error: string) => void
  ): void {
    this.ros
      .callService(this.name, this.serviceType, request)
      .then((response) => {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Roslib-API boundary: `TResp` is a caller-supplied nominal type; the CDR reader delivers `Record<string, unknown>` whose shape already matches `TResp` at runtime because the service schema drove the decode.
        onSuccess?.(response as TResp);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        onError?.(msg);
      });
  }
}

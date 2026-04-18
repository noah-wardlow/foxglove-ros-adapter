/**
 * Param class — drop-in replacement for roslib's ROSLIB.Param.
 *
 * Provides get/set matching the roslib API.
 * Uses foxglove_bridge's parameter operations.
 */

import { Ros } from "./ros";

export interface ParamOptions {
  ros: Ros;
  name: string;
}

export class Param {
  readonly ros: Ros;
  readonly name: string;

  constructor(options: ParamOptions) {
    this.ros = options.ros;
    this.name = options.name;
  }

  /**
   * Overload: callers often pass a typed callback
   * (e.g. `(v: string) => setState(v)`) where our actual runtime value is
   * `unknown`. TypeScript matches the generic overload at call sites while
   * the implementation handles `unknown` — runtime validation is the
   * caller's job, same convention as `roslib`'s original `Param.get` typing.
   */
  get<T>(callback: (value: T) => void): void;
  get(callback: (value: unknown) => void): void;
  get(callback: (value: unknown) => void): void {
    this.ros
      .getParam(this.name)
      .then(callback)
      .catch((err) => {
        console.warn(`Param.get("${this.name}") failed:`, err);
        callback(null);
      });
  }

  set(
    value: unknown,
    onSuccess?: (value?: unknown) => void,
    onError?: (error: string) => void
  ): void {
    this.ros
      .setParam(this.name, value)
      .then(() => onSuccess?.())
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        onError?.(msg);
      });
  }
}

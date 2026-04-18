// Ambient declaration for the openclaw peer dependency.
// Consumers with `openclaw` installed get real types; this stub keeps the
// package building standalone when the peer is absent (e.g. in CI lint).
declare module "openclaw/plugin-sdk" {
  export type OpenClawPluginApi = any;
  export type ChannelPlugin<_Account = any> = any;
  export type PluginRuntime = any;
  export function emptyPluginConfigSchema(): any;
}

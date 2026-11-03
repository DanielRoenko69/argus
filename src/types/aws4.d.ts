declare module 'aws4' {
  export interface SignOptions {
    host?: string;
    path?: string;
    service?: string;
    region?: string;
    method?: string;
    headers?: Record<string, string | string[] | undefined>;
    body?: string;
    signQuery?: boolean;
    extraHeadersToInclude?: Record<string, boolean>;
    extraHeadersToIgnore?: Record<string, boolean>;
  }

  export interface Credentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  }

  export interface SignedRequest {
    headers: Record<string, string | string[]>;
    [key: string]: unknown;
  }

  export function sign(options: SignOptions, credentials?: Credentials): SignedRequest;
}

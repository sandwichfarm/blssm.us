declare module "@bunny.net/edgescript-sdk" {
  export namespace net {
    export namespace http {
      export function serve(
        handler: (request: Request) => Response | Promise<Response>,
      ): void;
      export function serve(
        options: { port: number; hostname: string },
        handler: (request: Request) => Response | Promise<Response>,
      ): void;
    }
  }
}

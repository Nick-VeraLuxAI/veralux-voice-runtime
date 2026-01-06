export interface AmrWbModule {
  cwrap: (
    ident: string,
    returnType: string | null,
    argTypes: string[]
  ) => (...args: number[]) => number;

  _malloc(size: number): number;
  _free(ptr: number): void;

  HEAPU8: Uint8Array;
  HEAP16: Int16Array;
}

export interface AmrWbModuleOptions {
  locateFile?: (path: string, prefix?: string) => string;
}

declare const createAmrWbModule: (
  options?: AmrWbModuleOptions
) => Promise<AmrWbModule>;

export default createAmrWbModule;
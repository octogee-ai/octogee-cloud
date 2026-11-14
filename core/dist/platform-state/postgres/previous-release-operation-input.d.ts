import type { Operation } from "@octogee/shared/types/glm";
type Input = Record<string, unknown>;
export declare function operationInputFromStored(input: Input): Input;
export declare function operationInputForStore(input: Input): Input;
export declare function operationForStore<T extends Pick<Operation, "input">>(operation: T): T;
export {};

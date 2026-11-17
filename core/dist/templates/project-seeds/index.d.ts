import type { ProjectRecipeId } from "@octogee/shared/types/project";
export interface PlaybookSeed {
    relPath: string;
    content: string;
}
export interface ProjectRecipeStarterSeed extends PlaybookSeed {
    encoding?: "base64";
}
export interface ProjectPlaybookSeedInput {
    projectName: string;
    projectType: string | null;
    recipe: ProjectRecipeId;
    today: string;
}
export interface ProjectRecipeStarterSeedInput {
    projectSlug: string;
    recipe: ProjectRecipeId;
}
export declare function notesWelcomeSeed(scopeName: string): PlaybookSeed;
export declare function projectPlaybookSeeds(input: ProjectPlaybookSeedInput): PlaybookSeed[];
export declare function projectRecipeStarterSeeds(input: ProjectRecipeStarterSeedInput): ProjectRecipeStarterSeed[];

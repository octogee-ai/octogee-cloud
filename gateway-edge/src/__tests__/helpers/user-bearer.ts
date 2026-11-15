import { UserCredentialRejected, type UserDocument } from "@octogee/core/user-identity-provider";
import { installUserIdentityProvider } from "@octogee/core/http/auth";

export function installBearerUids(
  uidFor: (token: string) => Promise<string>,
  userFor: (uid: string) => UserDocument | null = () => null,
): void {
  installUserIdentityProvider({
    verifyBearer: async (token) => {
      try {
        return { uid: await uidFor(token), authTime: null };
      } catch (error) {
        throw new UserCredentialRejected(error instanceof Error ? error.message : String(error));
      }
    },
    loadUser: async (uid) => userFor(uid),
  });
}

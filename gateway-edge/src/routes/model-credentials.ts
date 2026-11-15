import { authenticatedRequestLimit, authenticationFailureLimit } from "@octogee/core/http/authenticated-request-limit";
import { Router } from "express";

import { requireActiveAccount, requireAuthenticatedUid } from "@octogee/core/http/auth";
import {
  deleteModelCredentialKey,
  saveModelCredentialKey,
} from "./billing/byot.js";
import subscriptionRoutes from "./byosub.js";

const router: Router = Router();

router.post("/", authenticationFailureLimit, requireAuthenticatedUid, authenticatedRequestLimit(30), requireActiveAccount, saveModelCredentialKey);
router.delete("/", authenticationFailureLimit, requireAuthenticatedUid, authenticatedRequestLimit(30), requireActiveAccount, deleteModelCredentialKey);
router.use("/subscription", subscriptionRoutes);

export default router;

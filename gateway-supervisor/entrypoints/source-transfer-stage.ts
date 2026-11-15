import { prepareSourceTransferStage } from '../lib/source-transfer-stage.js';
const [phase, scratch, executionId] = process.argv.slice(2);
prepareSourceTransferStage(phase ?? '', scratch ?? '', executionId ?? '', process.env.SOURCE_POD_UID ?? '').catch(() => {
 process.stderr.write('source transfer stage failed\n');
 process.exitCode = 1;
});

import { readFileAction } from "./actions/read_file";
import { runShell } from "./actions/run_shell";
import { sendEmail } from "./actions/send_email";
import { webSearch } from "./actions/web_search";
import { writeFileAction } from "./actions/write_file";

export const registry: Record<string, unknown> = {
  send_email: sendEmail,
  web_search: webSearch,
  read_file: readFileAction,
  write_file: writeFileAction,
  run_shell: runShell,
};

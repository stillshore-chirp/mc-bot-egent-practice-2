const exactStopCommand = "緊急停止命令";

/** Match only the complete owner stop token; callers must pass the unmodified message. */
export function isImmediateStopCommand(message: string): boolean {
  return message === exactStopCommand;
}

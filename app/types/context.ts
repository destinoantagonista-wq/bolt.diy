export type ContextAnnotation =
  | {
      type: 'codeContext';
      files: string[];
    }
  | {
      type: 'chatSummary';
      summary: string;
      chatId: string;
    };

export type ProgressStatus = 'in-progress' | 'complete' | 'error';

export type ProgressAnnotation = {
  type: 'progress';
  label: string;
  status: ProgressStatus;
  order: number;
  message: string;
};

export type AgentEventLevel = 'info' | 'warning' | 'error';

export type AgentEventAnnotation = {
  type: 'agent-event';
  id: string;
  order: number;
  timestamp: number;
  level: AgentEventLevel;
  message: string;
  stage?: string;
};

export type ToolCallAnnotation = {
  type: 'toolCall';
  toolCallId: string;
  serverName: string;
  toolName: string;
  toolDescription: string;
};

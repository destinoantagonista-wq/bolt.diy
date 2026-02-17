export interface AgentQueueItem {
  id: string;
  prompt: string;
  createdAt: number;
  uploadedFiles: File[];
  imageDataList: string[];
}

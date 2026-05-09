import { AgentPage } from './AgentPage';

/**
 * 桌寵設定 root。P3 v1 只有 Agent 頁；未來新增 Display / Animation /
 * Expression / Performance 等頁時改為左側 nav + 右側 content 兩欄式。
 */
export function App(): React.ReactElement {
  return (
    <div className="h-full w-full overflow-y-auto bg-background text-foreground">
      <AgentPage />
    </div>
  );
}

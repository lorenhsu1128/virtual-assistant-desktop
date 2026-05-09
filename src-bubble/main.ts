import { BubbleApp } from './BubbleApp';

const root = document.getElementById('bubble-root');
if (root) {
  const app = new BubbleApp(root);
  void app.init();
}

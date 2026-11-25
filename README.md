# 赤龍斬

手機 AR 斬龍遊戲（Android Chrome，需支援 WebXR）。電腦瀏覽器會自動進入模擬場景。

## 上傳方式
把整個 `chilong` 資料夾放進 GitHub 儲存庫（例如放在根目錄），開啟 GitHub Pages 後，網址是：
`https://<你的帳號>.github.io/<儲存庫名稱>/chilong/`

AR 和麥克風都需要 https，GitHub Pages 本身就是 https。

## 檔案
- `index.html`：頁面
- `js/game.js`：遊戲主程式（規則數字都在最上面的 `RULE`）
- `js/dragon.js`：邪龍 3D 模型
- `js/common.js`：音效引擎、戰鬥配樂
- `js/config.js`：Firebase 登入設定（沒設定時只能用訪客身分）
- `img/story-v2.jpg`：故事圖
- `audio/`：故事配樂、戰鬥配樂
- `audio/sfx/`：出劍、劍飛行、火球噴出、火球飛行、爆炸音效（缺檔時會自動改用即時合成音）

## 配樂
- 故事配樂：管樂合奏《不良思緒漸漸散去》（Bad Thoughts Fade Away），作曲 Peter Bruno，音樂來源：正見網・天音網（https://big5.zhengjian.org/node/305115），正見網版權所有 ©1999-2026 ZHENGJIAN.ORG
- 戰鬥配樂：原創武俠風戰鬥曲，本遊戲專用

## 版權
© 2026 wingfeeling 版權所有

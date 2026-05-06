# 內部客服系統 MVP

這是一套簡單免費自架客服系統，功能包含：

- 落地頁右下角聊天窗口
- 多客服後台登入
- 即時聊天
- 對話列表
- 內部備註
- 狀態管理：open / pending / closed
- 指派客服欄位
- SQLite 本機資料庫

## 本機測試

```bash
npm install
cp .env.example .env
npm start
```

開啟：

- 後台：http://localhost:3000/admin/login.html
- 預設帳密：admin / 123456

## 嵌入你的落地頁

部署完成後，在落地頁 `</body>` 前放：

```html
<script src="https://你的客服系統網址/widget.js"></script>
```

例如本機測試：

```html
<script src="http://localhost:3000/widget.js"></script>
```

## 設定客服帳號

修改 `.env`：

```env
ADMIN_USERS=admin:123456,kefu1:abc123,kefu2:abc123
```

## 部署到 Railway

1. 把整個資料夾上傳到 GitHub repo
2. Railway 建立 New Project
3. 選 Deploy from GitHub Repo
4. 設定 Variables：

```env
SESSION_SECRET=請換成很長的隨機字串
ADMIN_USERS=admin:你的密碼,kefu1:客服密碼,kefu2:客服密碼
WIDGET_TITLE=Suporte Online
WIDGET_GREETING=Ola! Como podemos ajudar?
```

5. 部署成功後，用 Railway 網址開啟：

```text
https://你的網址/admin/login.html
```

6. 落地頁放入：

```html
<script src="https://你的網址/widget.js"></script>
```

## 注意

這是 MVP 版本，適合內部簡單使用。若正式大量廣告流量使用，建議後續升級：

- PostgreSQL
- 客服權限分級
- 訪客封鎖
- 對話搜尋
- 圖片上傳
- 對話匯出

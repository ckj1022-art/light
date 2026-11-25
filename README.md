# 島嶼微光 Island of Light・雲端版架設說明

這包檔案放上 GitHub Pages 就是一個完整的網站。先不設定雲端也能用：每個人的紀念會存在自己的裝置上。
照下面步驟接上 Firebase 之後，就會變成**大家共用的同一座園區**：

- **登入**：系統登錄碼（不需要電子郵件）、Google 帳號、電子郵件登入連結；不登入也可以逛、問候、獻花
- **紀念存在雲端**：換手機、換瀏覽器都找得回來；別人點亮的水晶會即時出現在你的島上
- **信可以隨時修改或收回**；信可以設定給「所有人／家人／只有自己」看
- **家人碼**：點亮紀念的人產生一組家人碼傳給家人，家人就能看見「不公開」的紀念，也能寫給家人看的信
- **搬上雲端**：原本存在這台裝置的紀念，登入後可以一鍵搬到雲端
- **管理員隱藏**：管理員可以把不適當的紀念隱藏起來

---

## 檔案

| 檔案 | 用途 |
|---|---|
| `index.html` | 遊戲本體 |
| `firebase-config.js` | **唯一需要你修改的檔案**：貼上 Firebase 設定 |
| `starcloak-data.js`、`lumi-data.js`、`lumi.glb`、`daynight-lighting.js` | 小光的造型與光影資料 |
| `firestore.rules` | 資料庫安全規則（貼到 Firebase 主控台） |
| `storage.rules` | 照片儲存規則（只有開啟 Storage 才需要） |

---

## 一、放上 GitHub Pages

1. 在 GitHub 建立一個新的 repository，例如 `kinmen-light`（設為 Public）。
2. 把這個資料夾裡的所有檔案上傳到 repository 的根目錄（`README.md`、`.rules` 檔也可以一起放，不影響網站）。
3. repository → **Settings → Pages** → Source 選 **Deploy from a branch**，Branch 選 `main`、資料夾 `/ (root)` → Save。
4. 幾分鐘後網址會是 `https://你的帳號.github.io/kinmen-light/`。先打開確認遊戲可以玩。

---

## 二、建立 Firebase 專案

1. 到 <https://console.firebase.google.com/> 用 Google 帳號登入 → **建立專案**（名稱例如 `kinmen-light`，Google Analytics 可以關掉）。
2. 專案首頁按 **「</>」（網頁）** 新增應用程式，暱稱隨意，**不用**勾選 Firebase Hosting。
3. 畫面會出現一段 `const firebaseConfig = { ... }`，先複製起來（第五步會用到）。

## 三、開啟登入方式

**建構（Build）→ Authentication → 開始使用 → Sign-in method**，依序啟用：

| 登入方式 | 設定 |
|---|---|
| **電子郵件／密碼** | 啟用「電子郵件/密碼」，**也要**啟用下面的「電子郵件連結（無密碼登入）」。系統登錄碼就是靠這個運作的 |
| **Google** | 啟用，選一個專案支援電子郵件 |
| **匿名** | 啟用（讓沒登入的訪客也能問候、獻花） |

接著到 **Authentication → 設定（Settings）→ 授權網域（Authorized domains）** → 新增網域：
`你的帳號.github.io`

> 用電子郵件登入連結時，信件預設是英文。可以在 **Authentication → 範本（Templates）** 把語言改成中文（繁體）。

## 四、建立資料庫並貼上規則

1. **建構 → Firestore Database → 建立資料庫**
   - 位置選 **asia-east1（台灣）**
   - 先選「正式版模式（production mode）」
2. 建好後切到 **規則（Rules）** 分頁，把 `firestore.rules` 的內容**全部貼上**取代原本的內容 → **發布**。

> 不需要建立任何索引，也不需要手動建立資料表；第一個人點亮水晶時會自動產生。

## 五、填寫 firebase-config.js

打開 `firebase-config.js`，把 `window.KL_FIREBASE_CONFIG = null;` 改成你在第二步複製的設定：

```js
window.KL_FIREBASE_CONFIG = {
  apiKey: "AIza....",
  authDomain: "kinmen-light.firebaseapp.com",
  projectId: "kinmen-light",
  storageBucket: "kinmen-light.firebasestorage.app",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef",
  useStorage: false
};
```

存檔、上傳覆蓋 GitHub 上的同名檔案。等一兩分鐘重新整理網站，左側選單會多一顆「登入」按鈕，就完成了。

> `apiKey` 放在公開網站上是正常的，它只是用來辨識專案；真正保護資料的是第四步的安全規則。

## 六、設定管理員（可以隱藏不適當的紀念）

1. 自己先在網站上登入一次（任何方式皆可）。
2. Firebase 主控台 → **Authentication → 使用者**，找到自己那一列，複製 **使用者 UID**。
3. **Firestore Database → 資料** → 新增集合 `admins` → 文件 ID 貼上你的 UID → 隨便加一個欄位（例如 `name`：`Ray`）→ 儲存。
4. 回到網站重新整理。打開別人的紀念卡，會多出「隱藏（管理）」按鈕。
5. 左側選單會多一顆「📊 園區統計」：今天來過、近 7 天、累計人數、各種登入方式的人數、各島點亮進度、大家留下的花／禮物／問候／信，以及最近點亮的紀念。只有管理員看得到。

---

## 照片存在哪裡？

- **預設（免費方案就能用）**：照片在上傳時會先壓縮成約 480 像素寬（大約 50–100 KB），直接存在那一筆紀念資料裡。
- **進階（需要 Blaze 方案）**：Firebase 從 2024 年 10 月起，新專案要使用 Cloud Storage 必須升級到 Blaze（用量計費，仍有免費額度）。升級後到 **建構 → Storage** 建立儲存空間、貼上 `storage.rules` 的內容，再把 `firebase-config.js` 裡的 `useStorage` 改成 `true`，之後的新照片就會放到 Storage。

## 費用大概多少？

免費的 Spark 方案每天有 5 萬次讀取、2 萬次寫入。每位訪客打開園區時，**每一顆已點亮的水晶算一次讀取**：

| 已點亮的水晶 | 每天大約可以容納的訪客（免費） |
|---|---|
| 50 顆 | 約 1,000 人次 |
| 200 顆 | 約 250 人次 |
| 500 顆（全滿） | 約 100 人次 |

超過時當天會暫時讀不到資料，隔天恢復。訪客多了之後可以升級 Blaze：讀取每 10 萬次約 US$0.04–0.06，一般社區規模每月通常只要幾十元台幣。

## 常見問題

**登錄碼忘了怎麼辦？**
登錄碼只存在使用者自己手上，管理員也看不到密碼。請大家拿到登錄碼後馬上截圖，或在「我的帳號」裡按「綁定 Google」多一條找回的路。

**家人碼要怎麼用？**
點亮紀念的人打開自己的紀念卡 → 按「家人碼」→ 複製傳給家人。家人登入後到「我的帳號 → 輸入家人碼」。家人碼可以隨時換新，換新後舊碼失效，但已經加入的家人不受影響。

**原本存在手機裡的紀念怎麼辦？**
登入後打開「我的帳號」，會看到「搬上雲端」。原本的位置如果已經被別人點亮，會自動換到最近的空位。佈置（點燈、相框、種花）仍然保存在原本那台裝置。

**「打不開登入視窗」或出現「授權網域」錯誤**
回到第三步，確認 `你的帳號.github.io` 已經加入授權網域。

**下一步：同時在線上看見彼此的小光**
這需要再開啟 Firebase Realtime Database，屬於第二階段，之後再加上。

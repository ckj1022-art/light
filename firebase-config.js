/* 島嶼微光・雲端設定
   1. 到 Firebase 主控台 → 專案設定 → 一般 → 你的應用程式（網頁）→ 複製 firebaseConfig
   2. 把下面的 null 換成那一段設定（保留 window.KL_FIREBASE_CONFIG = 開頭）
   3. 沒有填（維持 null）時，遊戲會照舊把紀念保存在每個人自己的裝置上 */
window.KL_FIREBASE_CONFIG = null;

/* 填好之後大概長這樣：
window.KL_FIREBASE_CONFIG = {
  apiKey: "AIza....",
  authDomain: "kinmen-light.firebaseapp.com",
  projectId: "kinmen-light",
  storageBucket: "kinmen-light.firebasestorage.app",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef",
  useStorage: false      // 照片預設壓縮後存在 Firestore（免費方案可用）。升級 Blaze 並開啟 Storage 後才改成 true
};
*/

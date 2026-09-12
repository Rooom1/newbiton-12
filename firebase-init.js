/**
 * firebase-init.js
 * Firebase 콘솔 > 프로젝트 설정(⚙️) > 내 앱 > </> 웹 앱 등록 후 나오는
 * firebaseConfig 값을 아래에 붙여넣으세요. databaseURL도 꼭 포함되어야 합니다
 * (Realtime Database를 쓰는 프로젝트라 이 값이 있어야 연결됩니다).
 */
const firebaseConfig = {
  apiKey: "AIzaSyAr14uUHsTN1yC2zxDO8JaX51qgyPhKzBA",
  authDomain: "newbi12.firebaseapp.com",
  databaseURL: "https://newbi12-default-rtdb.firebaseio.com",
  projectId: "newbi12",
  storageBucket: "newbi12.firebasestorage.app",
  messagingSenderId: "291814793190",
  appId: "1:291814793190:web:7a568db51012c903508027"
};
 
firebase.initializeApp(firebaseConfig);
 
// main.js에서 바로 쓸 수 있도록 전역에 노출 (Realtime Database)
window.db = firebase.database();
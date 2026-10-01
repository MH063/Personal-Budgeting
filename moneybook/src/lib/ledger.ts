// 模块级当前账本 id（由 store 初始化/切换时同步）
// API 层通过 currentLedgerId() 同步读取，避免层层传参
let current: number = 1;

export function setCurrentLedger(id: number) {
  current = id;
}

export function currentLedgerId(): number {
  return current;
}
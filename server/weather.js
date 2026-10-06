// 天气规则表：这条分线的天不只换天空，也换玩法。
// 这是唯一的口径，客户端 src/main.js 镜像同样四个数字（ui-wiring 守着两边对齐），
// 所以「下雨的星屑更润」这件事不会前端一套、后端一套。
export const WEATHER = ['clear', 'petal', 'rain', 'fog', 'meteor'];
export const W = { clear: 0, petal: 1, rain: 2, fog: 3, meteor: 4 };

// 细雨：湿润的星屑更好收集，一枚碎片给两枚星尘（服务端加发，客户端只负责说一声）
export const shardGem = (c) => (c === W.rain ? 2 : 1);
// 流星夜：树下的愿望有人听见，多给两枚
export const wishGem = (c) => (c === W.meteor ? 2 : 0);
// 樱吹雪：花瓣托住滑翔（客户端手感）
export const glideMul = (c) => (c === W.petal ? 0.55 : 1);
// 薄雾：鹿看不清人，也就不急着躲；而且它开始朝最近一枚没被采走的星屑走去
export const deerFlee = (c) => (c === W.fog ? 3.2 : 9);
export const deerGuides = (c) => c === W.fog;

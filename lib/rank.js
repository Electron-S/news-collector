'use strict';

// 양질 뉴스 선별용 순수 함수 모음(네트워크/상태 없음 → 단위테스트 용이).

// HN 스타일 인기·시간 감쇠 점수: (points-1) / (ageHours+2)^gravity.
// 인기가 높고 최근일수록 높다. gravity 기본 1.8(HN 기본값).
function gravityScore(points, ageHours, gravity = 1.8) {
  const p = Math.max(0, Number(points) - 1);
  const t = Math.max(0, Number(ageHours));
  return p / Math.pow(t + 2, gravity);
}

// 제목을 비교용 토큰 집합으로(2글자 이상, 기호 제거, 소문자).
function titleTokens(s) {
  return new Set(
    String(s ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1)
  );
}

// 두 텍스트의 토큰 Jaccard 유사도(0~1). 근접 중복 판단용.
function jaccard(a, b) {
  const A = titleTokens(a);
  const B = titleTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// 근접 중복 제거(다양성 확보, MMR-lite): 이미 채택된 것과 유사도 >= threshold 면 버린다.
// items 는 점수 내림차순으로 미리 정렬돼 있다고 가정(상위 우선 유지).
function dedupeSimilar(items, getText, threshold = 0.6) {
  const kept = [];
  for (const it of items) {
    const t = getText(it);
    if (kept.some((k) => jaccard(getText(k), t) >= threshold)) continue;
    kept.push(it);
  }
  return kept;
}

// 텍스트에 포함된 관심 키워드 개수(점수 보너스 계산용).
function interestHits(text, interests = []) {
  const hay = String(text ?? '').toLowerCase();
  return interests.reduce((n, kw) => n + (hay.includes(String(kw).toLowerCase()) ? 1 : 0), 0);
}

// 관심 가중 보너스 배수. 매칭 키워드마다 (1 + 학습가중) 만큼 가산(가중<-1 이면 0으로 바닥).
// 피드백으로 선호 키워드는 가중↑ → 보너스↑, 비선호는 가중<0 → 보너스↓. 순수 함수.
function interestBoost(text, interests = [], kwWeights = {}) {
  const hay = String(text ?? '').toLowerCase();
  let s = 0;
  for (const kw of interests) {
    if (hay.includes(String(kw).toLowerCase())) s += Math.max(0, 1 + (Number(kwWeights[kw]) || 0));
  }
  return 1 + 0.3 * s;
}

module.exports = { gravityScore, titleTokens, jaccard, dedupeSimilar, interestHits, interestBoost };

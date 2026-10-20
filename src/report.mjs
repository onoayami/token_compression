export function formatStats(stats) {
  const number = value => new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 }).format(value);
  const percent = value => value === null ? '未計測（元データが0件または0サイズ）' : `${number(value)}%`;
  const c = stats.content, r = stats.returned_text, q = stats.coverage;
  return [
    '圧縮状況レポート（このルートのローカル資料のみ）',
    `読み取り ${number(stats.read_calls)}回 / 原文確認 ${number(stats.retrieve_calls)}回`,
    '',
    '【1. 資料そのものの変化】',
    `バイト数: ${number(c.original_bytes)} → ${number(c.compacted_bytes)} bytes`,
    `削減: ${number(c.reduction_bytes)} bytes / ${percent(c.reduction_percent_by_bytes)}`,
    `文字数: ${number(c.original_characters)} → ${number(c.compacted_characters)}文字`,
    `文字数の削減率: ${percent(c.reduction_percent_by_characters)}`,
    `計測対象: ${number(c.measured_read_calls)}回（旧形式で未計測: ${number(c.legacy_unmeasured_read_calls)}回）`,
    '',
    '【2. 説明・原文の再取得も含めた参考比較】',
    `読み取り時の返却テキスト（説明込み）: ${number(r.read_response_bytes_including_metadata)} bytes`,
    `原文確認の返却テキスト（説明込み）: ${number(r.retrieval_response_bytes_including_metadata)} bytes`,
    `共通知識の一覧の返却テキスト: ${number(r.context_index_response_bytes || 0)} bytes`,
    `返却テキスト合計: ${number(r.total_response_bytes)} bytes`,
    `元資料全文との参考差: ${number(r.reference_byte_delta_vs_original_full_text)} bytes / ${percent(r.reference_reduction_percent_vs_original_full_text)}`,
    '※マイナスなら、元資料全文より返却テキストが増えています。',
    '',
    '【3. 情報の省略・確認範囲】',
    `情報落ちのあるpreview: ${number(q.lossy_preview_calls)}回`,
    `大きすぎて本文を表示せず、原文をページ取得する読み取り: ${number(q.body_omitted_for_paging_calls)}回`,
    `完全一致の繰り返しを集約した行: ${number(q.folded_exact_repeat_lines)}行`,
    '',
    '【未計測】Copilot全体のトークン数・料金・会話要約の消費・品質。',
    'この値をトークン削減率や節約金額として扱わないでください。',
    'ツール定義・プロンプト・統計呼び出し・通信外枠・モデルによる再読込は参考差に含みません。',
    '上限による本文未表示は「100%圧縮」とは扱いません。previewの省略も品質維持を保証しません。',
    '統計は約1MiBで区切られる直近分です。purgeでリセットされます。',
  ].join('\n');
}

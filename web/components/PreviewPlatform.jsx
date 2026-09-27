"use client";
import { useState } from "react";
import { Share2 } from "lucide-react";
import Platform from "./Platform";
import styles from "./DemoProjectShare.module.css";
import { useI18n } from "../lib/i18n";
export default function PreviewPlatform() {
  const { locale } = useI18n();
  const [sharePreviewRequest, setSharePreviewRequest] = useState(0);
  return (
    <>
      <Platform sharePreviewRequest={sharePreviewRequest} />
      <aside className="preview-banner">
        <strong>{locale === "en" ? "Demo preview" : "演示预览"}</strong>
        <span>
          {locale === "en"
            ? "Sample data. No real transactions."
            : "样例数据，不会提交真实交易。"}
        </span>
        <button className={styles.entry} type="button" onClick={() => setSharePreviewRequest(value => value + 1)}><Share2 size={16} aria-hidden="true" />{locale === "en" ? "Preview sharing" : "查看分享效果"}</button>
        <a href={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/`}>
          {locale === "en" ? "Back to BEMine" : "返回拼矿"} ↗
        </a>
      </aside>
    </>
  );
}

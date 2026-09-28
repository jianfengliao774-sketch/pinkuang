/** Use the existing X-safe wording as one preview for both user-controlled composers. */
export function commonSharePreview(model) {
  if (!model) return null;
  const telegram = new URL(model.telegramUrl);
  telegram.searchParams.set('text', model.xText);
  return {
    text: model.xText,
    copyText: `${model.xText}\n${model.url}`,
    telegramUrl: telegram.href,
  };
}

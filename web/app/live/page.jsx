export const metadata = { title: '拼矿 BEMine · 页面已停用' };

export default function LivePage() {
  return <main style={{ maxWidth: 640, margin: '12vh auto', padding: 32, fontFamily: 'sans-serif' }}>
    <h1>旧版工作台已停用</h1>
    <p>请使用新版拼矿页面继续操作。</p>
    <a href={`${process.env.NEXT_PUBLIC_BASE_PATH || ''}/`}>前往新版拼矿</a>
  </main>;
}

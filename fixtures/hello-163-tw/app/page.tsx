export default function Home() {
  const nums: number[] = [1, 2, 3]
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 text-2xl font-bold text-blue-600">
      hello from turbopack-wasi: {nums.reduce((a, b) => a + b, 0)}
    </main>
  )
}

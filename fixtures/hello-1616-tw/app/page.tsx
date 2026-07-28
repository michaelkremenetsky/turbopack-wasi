export default function Home() {
  const nums: number[] = [1, 2, 3]
  return (
    <main className="mx-auto max-w-md rounded-lg bg-slate-100 p-4 text-lg">
      hello from turbopack-wasi + tailwind: {nums.reduce((a, b) => a + b, 0)}
    </main>
  )
}

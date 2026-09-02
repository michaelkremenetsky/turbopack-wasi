export default function Home() {
  const nums: number[] = [1, 2, 3]
  return <main>hello from turbopack-wasi: {nums.reduce((a, b) => a + b, 0)}</main>
}

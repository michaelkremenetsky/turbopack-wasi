export async function getServerSideProps() {
  return { props: { where: "src/pages/auth/login (nested)" } };
}

export default function Login({ where }: { where: string }) {
  return <main>{where}</main>;
}

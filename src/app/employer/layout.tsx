import { EmployerNavbar } from '@/components/navigation/employer-navbar';

export default function EmployerLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <EmployerNavbar />
      {children}
    </>
  );
}

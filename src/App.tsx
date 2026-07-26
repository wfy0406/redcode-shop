import { Routes, Route } from 'react-router';
import Layout from '@/components/Layout';
import Home from '@/pages/Home';
import Products from '@/pages/Products';
import ProductDetail from '@/pages/ProductDetail';
import Live from '@/pages/Live';
import About from '@/pages/About';
import Login from '@/pages/Login';
import Register from '@/pages/Register';
import Cart from '@/pages/Cart';
import Checkout from '@/pages/Checkout';
import Account from '@/pages/Account';
import Payment from '@/pages/Payment';
import Admin from '@/pages/Admin';

/**
 * Routing contract：Nested-route pattern（react-dev.md Pattern B）
 * Layout render <Outlet/>，所以呢度用巢狀 <Route>，唔好溝 children pattern。
 */
export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="products" element={<Products />} />
        <Route path="products/:id" element={<ProductDetail />} />
        <Route path="live" element={<Live />} />
        <Route path="about" element={<About />} />
        <Route path="login" element={<Login />} />
        <Route path="register" element={<Register />} />
        <Route path="cart" element={<Cart />} />
        <Route path="checkout" element={<Checkout />} />
        <Route path="account" element={<Account />} />
        <Route path="payment" element={<Payment />} />
        <Route path="admin" element={<Admin />} />
      </Route>
    </Routes>
  );
}

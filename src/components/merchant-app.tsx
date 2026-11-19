"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowDownRight, ArrowRight, ArrowUpRight, BadgePercent, Bell, BellRing, Bike, BookOpen, CalendarDays, Check, CheckCircle2, ChefHat, ChevronDown, ChevronLeft, ChevronRight, CircleDollarSign, Clock3, CreditCard, Download, ExternalLink, Headphones, HelpCircle, Home, Info, KeyRound, LayoutGrid, Link2, LogOut, Mail, Menu as MenuIcon, MoreHorizontal, PackageCheck, Plus, Search, Settings2, ShieldCheck, ShoppingBag, Sparkles, Star, Store, Trash2, Users, UtensilsCrossed, WifiOff, X } from "lucide-react";
import { AccountModal, Api401Error, AUTH_EXPIRED_EVENT, api, DecisionModal, FulfilmentModal, MenuModal, Modal, OfferModal, PasswordModal, SetupModal, type MenuInput } from "@/components/dialogs";
import { BusinessSettings } from "@/components/business-settings";
import { OrderCard, statusLabel, timeAgo, type OrderAction } from "@/components/order-card";
import { demoBusiness, demoMenu, demoOverview, makeDemoOffers, makeDemoOrders } from "@/lib/demo";
import { MARKETPLACE_LINK_INVALID } from "@/lib/marketplace-link-status";
import { discountLabel, isOfferLive } from "@/lib/offers";
import { normalizeRevenueRange, rangeForPreset, revenueRangeLabel, REVENUE_PRESETS, type RevenuePreset, type RevenueRange } from "@/lib/revenue";
import { can, ROLE_DESCRIPTIONS, ROLE_LABELS, STAFF_ROLES, type AppRole, type Permission, type StaffRole } from "@/lib/roles";
import { localReviewThemes } from "@/lib/review-themes";
import { money, type AuthResponse, type AuthUser, type Business, type FeedbackSummary, type MenuItem, type Offer, type OfferInput, type Order, type OrderStatus, type Overview, type Review, type ReviewInbox, type ReviewTheme, type RevenueSummary, type StaffMember } from "@/lib/types";

type Page = "home" | "orders" | "menu" | "offers" | "reviews" | "staff" | "earnings" | "more";
type User = AuthUser;
type AuthData = AuthResponse;
type Filter = "active" | "all" | "new" | "accepted" | "preparing" | "ready" | "out_for_delivery" | "completed" | "cancelled" | "feedback";
const emptyOverview: Overview = { counts: { new: 0, accepted: 0, preparing: 0, ready: 0, out_for_delivery: 0, completed: 0, cancelled: 0, rejected: 0 }, todaySales: 0, todayOrders: 0, completedToday: 0, settlements: [], settlementSync: { linked: false, status: "idle", lastSyncedAt: null }, feedback: { available: true, windowDays: 30, averageRating: null, reviewCount: 0, badOrders: 0, pendingReplies: 0 } };
const emptyFeedback: FeedbackSummary = { available: true, windowDays: 30, averageRating: null, reviewCount: 0, badOrders: 0, pendingReplies: 0 };
const navItems: { id: Page; label: string; icon: typeof Home; permission?: Permission }[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "orders", label: "Orders", icon: ShoppingBag, permission: "orders.read" },
  { id: "menu", label: "Menu", icon: BookOpen, permission: "menu.read" },
  { id: "offers", label: "Offers", icon: BadgePercent, permission: "offers.read" },
  { id: "reviews", label: "Reviews", icon: Star, permission: "feedback.write" },
  { id: "staff", label: "Staff", icon: Users, permission: "staff.write" },
  { id: "earnings", label: "Earnings", icon: CircleDollarSign, permission: "settlements.read" },
  { id: "more", label: "More", icon: LayoutGrid },
];
const filters: { id: Filter; label: string }[] = [{ id: "active", label: "Active" }, { id: "new", label: "New" }, { id: "accepted", label: "Accepted" }, { id: "preparing", label: "Preparing" }, { id: "ready", label: "Ready" }, { id: "out_for_delivery", label: "Out for delivery" }, { id: "completed", label: "Completed" }, { id: "feedback", label: "Feedback" }, { id: "cancelled", label: "Cancelled" }, { id: "all", label: "All" }];
function initials(name: string) { return name.split(" ").filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "S"; }
function isInHours(business: Business) { if (!business.hoursEnabled) return true; const current = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()); return business.opensAt <= business.closesAt ? current >= business.opensAt && current < business.closesAt : current >= business.opensAt || current < business.closesAt; }
function playAlert() { try { const audio = new AudioContext(); const oscillator = audio.createOscillator(); const gain = audio.createGain(); oscillator.type = "sine"; oscillator.frequency.value = 740; gain.gain.setValueAtTime(0.08, audio.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.35); oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + 0.35); oscillator.onended = () => { void audio.close(); }; } catch { /* Browser sound policies may block playback. */ } }
function greeting() { const hour = new Date().getHours(); return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"; }
function demoRevenue(orders: Order[], range: RevenueRange): RevenueSummary {
  const normalized = normalizeRevenueRange(range.from, range.to) ?? { from: null, to: null, fromDate: null, toExclusiveDate: null };
  const completed = orders.filter((order) => {
    if (order.status !== "completed") return false;
    const stamp = new Date(order.updatedAt).getTime();
    return (!normalized.fromDate || stamp >= normalized.fromDate.getTime())
      && (!normalized.toExclusiveDate || stamp < normalized.toExclusiveDate.getTime());
  });
  return {
    from: normalized.from,
    to: normalized.to,
    grossSales: completed.reduce((sum, order) => sum + order.total, 0),
    netPaid: 0,
    completedOrders: completed.length,
    paidSettlements: 0,
    currency: "INR",
  };
}
function subscribeToNetwork(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}
function getNetworkStatus() { return navigator.onLine; }

export default function MerchantApp() {
  const [demo, setDemo] = useState(true), [user, setUser] = useState<User | null>(null), [verificationRequired, setVerificationRequired] = useState(false), [business, setBusiness] = useState<Business | null>(demoBusiness), [role, setRole] = useState<AppRole>("owner");
  const [orders, setOrders] = useState<Order[]>(() => makeDemoOrders()), [items, setItems] = useState<MenuItem[]>(demoMenu), [overview, setOverview] = useState<Overview>(emptyOverview), [offers, setOffers] = useState<Offer[]>(() => makeDemoOffers(makeDemoOrders()));
  const [page, setPage] = useState<Page>("home"), [orderFilter, setOrderFilter] = useState<Filter>("active"), [homeFilter, setHomeFilter] = useState<"all" | "new" | "preparing" | "ready" | "out_for_delivery">("all");
  const [search, setSearch] = useState(""), [debouncedSearch, setDebouncedSearch] = useState(""), [from, setFrom] = useState(""), [to, setTo] = useState(""), [orderPage, setOrderPage] = useState(1), [hasMore, setHasMore] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false), [profileOpen, setProfileOpen] = useState(false), [passwordOpen, setPasswordOpen] = useState(false), [setupOpen, setSetupOpen] = useState(false), [menuDialog, setMenuDialog] = useState<{ item: MenuItem | null } | null>(null), [decision, setDecision] = useState<{ order: Order; action: OrderAction } | null>(null), [fulfilmentDialog, setFulfilmentDialog] = useState<{ order: Order; fulfilment: "pickup" | "delivery" } | null>(null), [fulfilmentBusy, setFulfilmentBusy] = useState(""), [details, setDetails] = useState<Order | null>(null), [notificationsOpen, setNotificationsOpen] = useState(false), [helpOpen, setHelpOpen] = useState(false), [offerDialog, setOfferDialog] = useState<{ offer: Offer | null } | null>(null), [offerFilter, setOfferFilter] = useState<"active" | "archived">("active"), [offerBusy, setOfferBusy] = useState(""), [offersError, setOffersError] = useState(""), [staff, setStaff] = useState<StaffMember[]>([]), [staffEmail, setStaffEmail] = useState(""), [staffRole, setStaffRole] = useState<StaffRole>("server"), [staffBusy, setStaffBusy] = useState(""), [staffError, setStaffError] = useState("");
  const online = useSyncExternalStore(subscribeToNetwork, getNetworkStatus, () => true);
  const [syncError, setSyncError] = useState(""), [toast, setToast] = useState(""), [busyStore, setBusyStore] = useState(false), [busyItem, setBusyItem] = useState(""), [refreshKey, setRefreshKey] = useState(0), [soundEnabled, setSoundEnabled] = useState(() => typeof window !== "undefined" && localStorage.getItem("savour-sound") === "on"), [notificationPermission, setNotificationPermission] = useState(() => typeof Notification !== "undefined" ? Notification.permission : "default"), [menuError, setMenuError] = useState(""), [resendingVerification, setResendingVerification] = useState(false), [settlementBusy, setSettlementBusy] = useState(false), [feedbackBusy, setFeedbackBusy] = useState(""), [linkInvalid, setLinkInvalid] = useState(false);
  const [earningsTab, setEarningsTab] = useState<"overview" | "revenue">("overview"), [revenuePreset, setRevenuePreset] = useState<RevenuePreset>("1m"), [revenueRange, setRevenueRange] = useState<RevenueRange>(() => rangeForPreset("1m"));
  const [revenue, setRevenue] = useState<RevenueSummary | null>(null), [revenueBusy, setRevenueBusy] = useState(false), [revenueError, setRevenueError] = useState("");
  const [reviews, setReviews] = useState<Review[]>([]), [reviewSummary, setReviewSummary] = useState<FeedbackSummary>(emptyFeedback), [reviewThemes, setReviewThemes] = useState<ReviewTheme[]>([]), [reviewsBusy, setReviewsBusy] = useState(false), [reviewsError, setReviewsError] = useState(""), [reviewReplyBusy, setReviewReplyBusy] = useState("");
  const lastNewCount = useRef<number | null>(null), lastNewId = useRef<string | null>(null), actionBusyRef = useRef<Set<string>>(new Set());
  const [actionBusy, setActionBusy] = useState<Record<string, boolean>>({});

  const activate = useCallback((data: AuthData) => {
    if (!data.user) return;
    setDemo(false); setUser(data.user); setVerificationRequired(data.verificationRequired); setBusiness(data.business); setRole(data.role ?? "owner"); setOrders([]); setItems([]); setOverview(emptyOverview); setOffers([]); setOffersError(""); setReviews([]); setReviewSummary(emptyFeedback); setReviewThemes([]); setReviewsError(""); setStaff([]); setStaffError(""); setOfferFilter("active"); setPage("home"); setAccountOpen(false); setLinkInvalid(false); lastNewCount.current = null; lastNewId.current = null;
    if (!data.business || data.business.approvalStatus === "draft") setSetupOpen(true);
  }, []);
  // Proactively check the pairing token so a dead link is obvious before any sync call fails.
  const checkLink = useCallback(async () => {
    if (demo || !business?.id) return;
    try {
      const status = await api<{ linked: boolean; valid: boolean | null }>("/api/merchant/marketplace-link");
      setLinkInvalid(Boolean(status.linked && status.valid === false));
    } catch { /* Best effort: live requests still surface a genuine failure. */ }
  }, [demo, business?.id]);
  // Check on mount; the setState in checkLink only resolves after the request settles.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void checkLink(); }, [checkLink]);
  useEffect(() => { let active = true; api<AuthData>("/api/auth").then((data) => { if (active && data.user) activate(data); }).catch(() => { if (active) setSyncError("Couldn’t reach the server. Try again when you’re online."); }); return () => { active = false; }; }, [activate]);
  useEffect(() => {
    const reset = () => {
      setDemo(true); setUser(null); setVerificationRequired(false); setBusiness(demoBusiness); setRole("owner");
      setOrders(makeDemoOrders()); setItems(demoMenu); setOverview(emptyOverview); setOffers(makeDemoOffers(makeDemoOrders())); setReviews([]); setReviewSummary(emptyFeedback); setReviewThemes([]); setReviewsError("");
      setPage("home"); setAccountOpen(false); setProfileOpen(false); setSetupOpen(false); setOfferFilter("active");
      setSyncError(""); setMenuError(""); setOffersError(""); setLinkInvalid(false); setToast("Your session expired. Please sign in again.");
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, reset);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, reset);
  }, []);
  useEffect(() => { const timeout = window.setTimeout(() => { setDebouncedSearch(search); setOrderPage(1); }, 350); return () => window.clearTimeout(timeout); }, [search]);
  useEffect(() => { if (!toast) return; const timeout = window.setTimeout(() => setToast(""), 4200); return () => window.clearTimeout(timeout); }, [toast]);
  useEffect(() => {
    if (demo || !business?.id || linkInvalid) return;
    let active = true;
    api<{ items: MenuItem[] }>("/api/merchant/menu").then((data) => { if (active) { setItems(data.items); setMenuError(""); } }).catch((error) => { if (active && !(error instanceof Api401Error && error.sessionExpired)) setMenuError(error.message); });
    return () => { active = false; };
  }, [demo, business?.id, refreshKey, linkInvalid]);
  useEffect(() => {
    if (demo || !business?.id) return;
    let active = true;
    api<{ offers: Offer[] }>("/api/merchant/offers").then((data) => { if (active) { setOffers(data.offers); setOffersError(""); } }).catch((error) => { if (active && !(error instanceof Api401Error && error.sessionExpired)) setOffersError(error.message); });
    return () => { active = false; };
  }, [demo, business?.id, refreshKey]);
  useEffect(() => {
    const refreshAfterLinkChange = () => { setRefreshKey((n) => n + 1); void checkLink(); };
    window.addEventListener("savour-marketplace-link-changed", refreshAfterLinkChange);
    return () => window.removeEventListener("savour-marketplace-link-changed", refreshAfterLinkChange);
  }, [checkLink]);
  useEffect(() => {
    if (demo || !business?.id || linkInvalid) return;
    let stopped = false, failures = 0, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!navigator.onLine || document.hidden) { timer = setTimeout(poll, 30000); return; }
      try {
        const params = new URLSearchParams({ status: page === "orders" ? orderFilter : "active", page: String(page === "orders" ? orderPage : 1), limit: "20" });
        if (page === "orders" && debouncedSearch) params.set("search", debouncedSearch);
        if (page === "orders" && from) params.set("from", from);
        if (page === "orders" && to) params.set("to", to);
        const [overviewData, orderData] = await Promise.all([api<{ business: Business; overview: Overview }>("/api/merchant/overview"), api<{ orders: Order[]; hasMore: boolean }>(`/api/merchant/orders?${params}`)]);
        if (stopped) return;
        const newCount = overviewData.overview.counts.new;
        if (lastNewCount.current !== null && (newCount > lastNewCount.current || (newCount === lastNewCount.current && newCount > 0 && lastNewId.current && overviewData.overview.latestNewOrderId && lastNewId.current !== overviewData.overview.latestNewOrderId))) {
          setToast("A new order needs your attention.");
          if (soundEnabled) playAlert();
          if ("Notification" in window && Notification.permission === "granted") { try { new Notification("New order on Savour", { body: "Open your workspace to review it." }); } catch { /* Notifications may be unavailable in this browser. */ } }
        }
        lastNewCount.current = newCount; lastNewId.current = overviewData.overview.latestNewOrderId || null; setBusiness((current) => current && current.id === overviewData.business.id && (!current.updatedAt || (overviewData.business.updatedAt && new Date(overviewData.business.updatedAt).getTime() >= new Date(current.updatedAt).getTime())) ? overviewData.business : current); setOverview(overviewData.overview); setOrders(orderData.orders); setHasMore(orderData.hasMore); setSyncError(""); failures = 0;
      } catch (error) {
        if (error instanceof Api401Error) {
          if (error.code === MARKETPLACE_LINK_INVALID) setLinkInvalid(true);
          if (!stopped && !error.sessionExpired) setSyncError(error.message);
          return;
        }
        if (!stopped) { failures++; setSyncError("Couldn’t sync the latest data. We’ll retry automatically."); }
      }
      if (!stopped) timer = setTimeout(poll, Math.min(30000 * 2 ** failures, 120000));
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [demo, business?.id, page, orderFilter, orderPage, debouncedSearch, from, to, refreshKey, soundEnabled, online, linkInvalid]);

  const vendor = business?.type === "vendor";
  const stats = demo ? demoOverview(orders) : overview;
  const paidSettlements = useMemo(() => stats.settlements.filter((settlement) => settlement.status === "paid"), [stats.settlements]);
  const settlementTotals = useMemo(() => paidSettlements.reduce((totals, settlement) => ({
    net: totals.net + settlement.netAmount,
    gross: totals.gross + settlement.grossAmount,
    fees: totals.fees + settlement.commissionAmount,
    refunds: totals.refunds + settlement.refundAmount,
    adjustments: totals.adjustments + settlement.adjustmentAmount,
  }), { net: 0, gross: 0, fees: 0, refunds: 0, adjustments: 0 }), [paidSettlements]);
  const revenueForView = demo ? demoRevenue(orders, revenueRange) : revenue;
  const reviewInboxForView = useMemo<ReviewInbox>(() => {
    if (!demo) return { reviews, summary: reviewSummary, themes: reviewThemes };
    const sample = orders.filter((order) => order.feedbackAt).map((order): Review => ({
      orderCode: order.id,
      rating: order.rating,
      review: order.review,
      feedbackAt: order.feedbackAt,
      merchantResponse: order.merchantResponse,
      merchantRespondedAt: order.merchantRespondedAt,
    }));
    return { reviews: sample, summary: stats.feedback, themes: localReviewThemes(sample) };
  }, [demo, orders, reviews, reviewSummary, reviewThemes, stats.feedback]);
  useEffect(() => {
    if (page !== "earnings" || earningsTab !== "revenue" || demo || !business?.id) return;
    let stopped = false;
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (revenueRange.from && revenueRange.to) {
      params.set("from", revenueRange.from);
      params.set("to", revenueRange.to);
    }
    api<{ revenue: RevenueSummary }>(`/api/merchant/revenue?${params}`, { signal: controller.signal })
      .then((data) => { if (!stopped) { setRevenue(data.revenue); setRevenueError(""); } })
      .catch((error) => {
        if (stopped) return;
        if (error instanceof Api401Error && error.sessionExpired) return;
        if (error instanceof Api401Error && error.code === MARKETPLACE_LINK_INVALID) setLinkInvalid(true);
        setRevenueError(error instanceof Error ? error.message : "Could not load revenue.");
      })
      .finally(() => { if (!stopped) setRevenueBusy(false); });
    return () => { stopped = true; controller.abort(); };
  }, [page, earningsTab, demo, orders, business?.id, revenueRange, refreshKey]);
  useEffect(() => {
    if (page !== "reviews" || demo || !business?.id || !can(role, "feedback.write") || linkInvalid) return;
    let stopped = false;
    const controller = new AbortController();
    api<ReviewInbox>("/api/merchant/feedback", { signal: controller.signal })
      .then((data) => {
        if (stopped) return;
        setReviews(data.reviews); setReviewSummary(data.summary); setReviewThemes(data.themes); setReviewsError("");
      })
      .catch((error) => {
        if (stopped || (error instanceof Api401Error && error.sessionExpired)) return;
        if (error instanceof Api401Error && error.code === MARKETPLACE_LINK_INVALID) setLinkInvalid(true);
        setReviewsError(error instanceof Error ? error.message : "Could not load reviews.");
      })
      .finally(() => { if (!stopped) setReviewsBusy(false); });
    return () => { stopped = true; controller.abort(); };
  }, [page, demo, business?.id, role, refreshKey, linkInvalid]);
  const visibleNav = navItems.filter((item) => (!vendor || item.id !== "more") && (!item.permission || can(role, item.permission)));
  useEffect(() => {
    if (demo || !business?.id || !can(role, "staff.write")) return;
    let active = true;
    api<{ staff: StaffMember[] }>("/api/merchant/staff").then((data) => { if (active) { setStaff(data.staff); setStaffError(""); } }).catch((error) => { if (active && !(error instanceof Api401Error && error.sessionExpired)) setStaffError(error.message); });
    return () => { active = false; };
  }, [demo, business?.id, role, refreshKey]);
  const activeCount = stats.counts.new + stats.counts.accepted + stats.counts.preparing + stats.counts.ready + stats.counts.out_for_delivery;
  const accepting = !!business && business.approvalStatus === "approved" && business.isOpen && (demo || isInHours(business));
  const filteredOrders = useMemo(() => {
    let result = orders;
    if (demo && page === "orders") {
      if (orderFilter === "active") result = result.filter((o) => ["new", "accepted", "preparing", "ready", "out_for_delivery"].includes(o.status));
      else if (orderFilter === "cancelled") result = result.filter((o) => ["rejected", "cancelled"].includes(o.status));
      else if (orderFilter !== "all") result = result.filter((o) => o.status === orderFilter);
      if (debouncedSearch) result = result.filter((o) => String(o.orderNumber).includes(debouncedSearch.replace(/\D/g, "")));
      if (from) result = result.filter((o) => o.createdAt.slice(0, 10) >= from);
      if (to) result = result.filter((o) => o.createdAt.slice(0, 10) <= to);
    }
    if (page === "orders" && orderFilter === "feedback") result = result.filter((o) => !!o.feedbackAt);
    if (page === "home") { result = result.filter((o) => ["new", "accepted", "preparing", "ready", "out_for_delivery"].includes(o.status)); if (homeFilter === "preparing") result = result.filter((o) => ["accepted", "preparing"].includes(o.status)); else if (homeFilter !== "all") result = result.filter((o) => o.status === homeFilter); }
    return result;
  }, [orders, demo, page, orderFilter, homeFilter, debouncedSearch, from, to]);
  const activeOrders = filteredOrders.slice(0, 4);
  const dateLabel = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
  const revenueLabel = revenueRangeLabel(revenueRange);
  const revenueExportHref = revenueRange.from && revenueRange.to
    ? `/api/merchant/exports?type=revenue&from=${encodeURIComponent(revenueRange.from)}&to=${encodeURIComponent(revenueRange.to)}`
    : "/api/merchant/exports?type=revenue";
  const name = business?.name || "Your business";

  function chooseRevenuePreset(preset: RevenuePreset) {
    setRevenuePreset(preset);
    if (preset === "custom") return;
    const next = rangeForPreset(preset);
    if (next.from !== revenueRange.from || next.to !== revenueRange.to) {
      if (!demo && business?.id) setRevenueBusy(true);
      setRevenueRange(next);
    }
  }
  function changeRevenueDate(side: "from" | "to", value: string) {
    const current = revenueRange.from && revenueRange.to ? revenueRange : rangeForPreset("1m");
    const next = side === "from"
      ? { from: value, to: current.to && current.to < value ? value : current.to }
      : { from: current.from && current.from > value ? value : current.from, to: value };
    if (next.from === revenueRange.from && next.to === revenueRange.to) return;
    setRevenuePreset("custom");
    if (!demo && business?.id) setRevenueBusy(true);
    setRevenueRange(next);
  }
  async function toggleStore() {
    if (!business || busyStore) return;
    if (business.isOpen && activeCount > 0 && !window.confirm(`You have ${activeCount} active order${activeCount === 1 ? "" : "s"}. Closing stops new orders but does not cancel existing ones. Continue?`)) return;
    setBusyStore(true);
    try { if (demo) setBusiness({ ...business, isOpen: !business.isOpen }); else { const data = await api<{ business: Business }>("/api/merchant/business", { method: "PATCH", body: JSON.stringify({ action: "availability", isOpen: !business.isOpen }) }); setBusiness(data.business); } setToast(business.isOpen ? "Store closed to new orders." : "Store availability updated."); }
    catch (err) { setToast(err instanceof Error ? err.message : "Could not update store."); } finally { setBusyStore(false); }
  }
  async function confirmOrder(prepMinutes: number, reason: string) {
    if (!decision) return;
    const { order, action } = decision;
    const patch = { prepMinutes: action === "accepted" ? prepMinutes : order.prepMinutes, rejectionReason: action === "rejected" ? reason : order.rejectionReason };
    if (demo) { applyOrderLocally(order, action as OrderStatus, patch); setToast(`Sample order #${order.orderNumber} updated.`); return; }
    applyOrderLocally(order, action as OrderStatus, patch);
    try { await api("/api/merchant/orders", { method: "PATCH", body: JSON.stringify({ id: order.id, expectedStatus: order.status, nextStatus: action, prepMinutes, reason }) }); setToast(`Order #${order.orderNumber} updated.`); setRefreshKey((n) => n + 1); }
    catch (error) { applyOrderLocally(order, order.status, { prepMinutes: order.prepMinutes, rejectionReason: order.rejectionReason }); setRefreshKey((n) => n + 1); throw error; }
  }
  async function changeFulfilment(order: Order, fulfilment: "pickup" | "delivery", addressText?: string) {
    setFulfilmentBusy(order.id);
    try {
      if (demo) {
        const nextAddress = addressText || order.deliveryAddress;
        setOrders((current) => current.map((o) => o.id === order.id ? { ...o, fulfilment, deliveryAddress: nextAddress, updatedAt: new Date().toISOString() } : o));
        setDetails((current) => current && current.id === order.id ? { ...current, fulfilment, deliveryAddress: nextAddress } : current);
        setToast(`Sample order #${order.orderNumber} switched to ${fulfilment}.`);
        return;
      }
      const data = await api<{ order: Partial<Order> }>("/api/merchant/orders", { method: "PATCH", body: JSON.stringify({ id: order.id, fulfilment, ...(addressText ? { addressText } : {}) }) });
      const returnedFulfilment = data.order.fulfilment === "pickup" || data.order.fulfilment === "delivery" ? data.order.fulfilment : fulfilment;
      const nextAddress = typeof data.order.deliveryAddress === "string" ? data.order.deliveryAddress : addressText || order.deliveryAddress;
      setOrders((current) => current.map((o) => o.id === order.id ? { ...o, fulfilment: returnedFulfilment, deliveryAddress: nextAddress, updatedAt: data.order.updatedAt || new Date().toISOString() } : o));
      setDetails((current) => current && current.id === order.id ? { ...current, fulfilment: returnedFulfilment, deliveryAddress: nextAddress } : current);
      setToast(`Order #${order.orderNumber} switched to ${returnedFulfilment}.`);
      setRefreshKey((n) => n + 1);
    } catch (error) {
      setRefreshKey((n) => n + 1);
      throw error;
    } finally {
      setFulfilmentBusy("");
    }
  }
  function handleFulfilmentChange(order: Order, fulfilment: "pickup" | "delivery") {
    if (fulfilment === order.fulfilment) return;
    if (fulfilment === "delivery" && !order.deliveryAddress.trim()) { setFulfilmentDialog({ order, fulfilment }); return; }
    void changeFulfilment(order, fulfilment).catch((error) => setToast(error instanceof Error ? error.message : "Could not update fulfilment."));
  }
  function applyOrderLocally(order: Order, status: OrderStatus, patch: Partial<Order> = {}) {
    const updatedAt = patch.updatedAt ?? new Date().toISOString();
    setOrders((current) => current.map((o) => o.id === order.id ? { ...o, ...patch, status, updatedAt } : o));
    setDetails((current) => current && current.id === order.id ? { ...current, ...patch, status, updatedAt } : current);
  }
  async function handleOrderAction(order: Order, action: OrderAction) {
    // Rejections need a reason, so they keep the small confirmation dialog.
    if (action === "rejected") { setDecision({ order, action }); return; }
    if (actionBusyRef.current.has(order.id) || order.status === action) return;
    actionBusyRef.current.add(order.id);
    setActionBusy((current) => ({ ...current, [order.id]: true }));
    // Update the UI first so the status changes on the very next frame, before the network round-trip.
    const previousStatus = order.status;
    const prepMinutes = order.prepMinutes ?? 20;
    applyOrderLocally(order, action as OrderStatus, action === "accepted" ? { prepMinutes } : {});
    try {
      if (demo) { setToast(`Sample order #${order.orderNumber} updated.`); return; }
      const data = await api<{ order?: Partial<Order> }>("/api/merchant/orders", { method: "PATCH", body: JSON.stringify({ id: order.id, expectedStatus: previousStatus, nextStatus: action, prepMinutes }) });
      const serverStatus = (data.order?.status as OrderStatus) || (action as OrderStatus);
      applyOrderLocally(order, serverStatus, data.order?.updatedAt ? { updatedAt: data.order.updatedAt } : {});
      setToast(`Order #${order.orderNumber} updated.`);
      setRefreshKey((n) => n + 1);
    } catch (error) {
      // Put the order back to its previous state if the server rejects the change.
      applyOrderLocally(order, previousStatus, { prepMinutes: order.prepMinutes, rejectionReason: order.rejectionReason });
      setToast(error instanceof Error ? error.message : "Could not update order.");
      setRefreshKey((n) => n + 1);
    } finally {
      actionBusyRef.current.delete(order.id);
      setActionBusy((current) => { const next = { ...current }; delete next[order.id]; return next; });
    }
  }
  async function saveMenu(input: MenuInput, id?: string) {
    if (demo) { if (id) setItems((current) => current.map((item) => item.id === id ? { ...item, ...input } : item)); else setItems((current) => [...current, { ...input, id: `demo-${Date.now()}`, businessId: "demo", available: true, archived: false }]); setToast("Sample menu updated."); return; }
    const data = await api<{ item: MenuItem }>("/api/merchant/menu", { method: id ? "PATCH" : "POST", body: JSON.stringify({ ...input, id }) });
    setItems((current) => id ? current.map((item) => item.id === id ? data.item : item) : [...current, data.item]); setToast("Menu item saved.");
  }
  async function toggleItem(item: MenuItem) {
    setBusyItem(item.id);
    try { if (demo) setItems((current) => current.map((i) => i.id === item.id ? { ...i, available: !i.available } : i)); else { const data = await api<{ item: MenuItem }>("/api/merchant/menu", { method: "PATCH", body: JSON.stringify({ action: "availability", id: item.id, available: !item.available }) }); setItems((current) => current.map((i) => i.id === item.id ? data.item : i)); } setToast(item.available ? "Item marked sold out." : "Item is available again."); }
    catch (err) { setToast(err instanceof Error ? err.message : "Could not update item."); } finally { setBusyItem(""); }
  }
  async function deleteItem(item: MenuItem) {
    if (!window.confirm(`Archive ${item.name}? It will no longer appear on your menu.`)) return;
    setBusyItem(item.id);
    try { if (!demo) await api("/api/merchant/menu", { method: "DELETE", body: JSON.stringify({ id: item.id }) }); setItems((current) => current.filter((i) => i.id !== item.id)); setToast("Item archived."); } catch (err) { setToast(err instanceof Error ? err.message : "Could not archive item."); } finally { setBusyItem(""); }
  }
  async function saveSettings(payload: Record<string, unknown>) {
    if (!business) return;
    if (demo) {
      if (payload.action === "closure") {
        setBusiness({ ...business, isOpen: payload.closed === false ? true : business.isOpen, closureReason: String(payload.reason ?? ""), closureUntil: String(payload.until ?? "") || null });
      } else if (payload.action === "leaves") {
        setBusiness({ ...business, scheduledLeaves: payload.leaves as Business["scheduledLeaves"] });
      } else setBusiness({ ...business, ...payload } as Business);
      return;
    }
    const data = await api<{ business: Business }>("/api/merchant/business", { method: "PATCH", body: JSON.stringify(payload) }); setBusiness(data.business);
  }
  async function endSession(action: "logout" | "logout-all", message: string) { try { await api("/api/auth", { method: "POST", body: JSON.stringify({ action }) }); setDemo(true); setUser(null); setVerificationRequired(false); setBusiness(demoBusiness); setOrders(makeDemoOrders()); setItems(demoMenu); setPage("home"); setToast(message); } catch (err) { setToast(err instanceof Error ? err.message : "Could not sign out."); } }
  function signOut() { return endSession("logout", "Signed out."); }
  function signOutEverywhere() { return endSession("logout-all", "Signed out of all devices."); }
  async function resendVerification() {
    setResendingVerification(true);
    try {
      const data = await api<{ sent: boolean; configured: boolean }>("/api/auth", { method: "POST", body: JSON.stringify({ action: "resend-verification" }) });
      setToast(data.configured ? data.sent ? "Verification email sent." : "We couldn’t send the email. Please try again later." : "Email delivery isn’t configured in this environment.");
    } catch (err) { setToast(err instanceof Error ? err.message : "Could not send verification email."); }
    finally { setResendingVerification(false); }
  }
  async function refreshSettlements() {
    if (demo || settlementBusy || !can(role, "settlements.read")) return;
    setSettlementBusy(true);
    try {
      const result = await api<{ applied: number; message?: string }>("/api/merchant/settlements/sync", { method: "POST" });
      setRefreshKey((n) => n + 1);
      setToast(result.message ?? (result.applied ? `Settlements updated: ${result.applied} record${result.applied === 1 ? "" : "s"} changed.` : "Settlements are up to date."));
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not refresh settlements.");
      setRefreshKey((n) => n + 1);
    } finally { setSettlementBusy(false); }
  }
  async function submitFeedbackReply(order: Order, response: string) {
    if (!response.trim() || feedbackBusy === order.id) return;
    const repliedAt = new Date().toISOString();
    if (demo) {
      setOrders((current) => current.map((o) => o.id === order.id ? { ...o, merchantResponse: response.trim(), merchantRespondedAt: repliedAt } : o));
      setDetails((current) => current && current.id === order.id ? { ...current, merchantResponse: response.trim(), merchantRespondedAt: repliedAt } : current);
      setToast("Your reply was added.");
      return;
    }
    setFeedbackBusy(order.id);
    try {
      const data = await api<{ feedback: { merchantResponse: string; merchantRespondedAt: string | null } | null; proxied: boolean }>("/api/merchant/feedback", { method: "PATCH", body: JSON.stringify({ id: order.id, orderCode: order.id, response }) });
      const reply = data.feedback?.merchantResponse ?? response.trim();
      const at = data.feedback?.merchantRespondedAt ?? repliedAt;
      setOrders((current) => current.map((o) => o.id === order.id ? { ...o, merchantResponse: reply, merchantRespondedAt: at } : o));
      setDetails((current) => current && current.id === order.id ? { ...current, merchantResponse: reply, merchantRespondedAt: at } : current);
      setToast(data.proxied ? "Reply sent to Marketplace." : "Your reply was added.");
      if (data.proxied) setRefreshKey((n) => n + 1);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not send your reply.");
    } finally { setFeedbackBusy(""); }
  }
  async function submitReviewReply(review: Review, response: string) {
    if (!can(role, "feedback.write") || !response.trim() || reviewReplyBusy === review.orderCode) return;
    const repliedAt = new Date().toISOString();
    if (demo) {
      setOrders((current) => current.map((order) => order.id === review.orderCode ? { ...order, merchantResponse: response.trim(), merchantRespondedAt: repliedAt } : order));
      setToast("Your reply was added.");
      return;
    }
    setReviewReplyBusy(review.orderCode);
    try {
      const data = await api<{ feedback: { merchantResponse: string; merchantRespondedAt: string | null } | null; proxied: boolean }>("/api/merchant/feedback", { method: "PATCH", body: JSON.stringify({ id: review.orderCode, orderCode: review.orderCode, response }) });
      const reply = data.feedback?.merchantResponse ?? response.trim();
      const at = data.feedback?.merchantRespondedAt ?? repliedAt;
      setReviews((current) => current.map((row) => row.orderCode === review.orderCode ? { ...row, merchantResponse: reply, merchantRespondedAt: at } : row));
      if (!review.merchantResponse) setReviewSummary((current) => ({ ...current, pendingReplies: Math.max(0, current.pendingReplies - 1) }));
      setToast(data.proxied ? "Reply sent to Marketplace." : "Your reply was added.");
      if (data.proxied) setRefreshKey((n) => n + 1);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not send your reply.");
    } finally { setReviewReplyBusy(""); }
  }
  function refreshReviews() { if (demo || linkInvalid) return; setReviewsBusy(true); setRefreshKey((n) => n + 1); }
  async function saveOffer(input: OfferInput, id?: string) {
    if (demo) {
      const stamp = new Date().toISOString();
      setOffers((current) => id
        ? current.map((offer) => offer.id === id ? { ...offer, ...input, updatedAt: stamp } : offer)
        : [{ id: `demo-offer-${Date.now()}`, businessId: demoBusiness.id, ...input, archived: false, createdAt: stamp, updatedAt: stamp, redemptions: 0, discountGiven: 0, influencedGross: 0 }, ...current]);
      setToast(id ? "Offer updated." : "Offer created.");
      return;
    }
    const data = await api<{ offer: Offer }>("/api/merchant/offers", { method: id ? "PATCH" : "POST", body: JSON.stringify({ ...input, ...(id ? { id } : {}) }) });
    setOffers((current) => id ? current.map((offer) => offer.id === id ? data.offer : offer) : [data.offer, ...current]);
    setOffersError(""); setToast(id ? "Offer updated." : "Offer created.");
  }
  async function toggleOffer(offer: Offer) {
    if (offerBusy === offer.id) return;
    const next = !offer.active;
    if (demo) { setOffers((current) => current.map((row) => row.id === offer.id ? { ...row, active: next } : row)); setToast(next ? `${offer.code} is live.` : `${offer.code} is paused.`); return; }
    setOfferBusy(offer.id);
    try {
      const data = await api<{ offer: Offer }>("/api/merchant/offers", { method: "PATCH", body: JSON.stringify({ id: offer.id, action: "toggle" }) });
      setOffers((current) => current.map((row) => row.id === offer.id ? data.offer : row)); setOffersError(""); setToast(next ? `${offer.code} is live.` : `${offer.code} is paused.`);
    } catch (error) { setToast(error instanceof Error ? error.message : "Could not update the offer."); }
    finally { setOfferBusy(""); }
  }
  async function archiveOffer(offer: Offer) {
    if (!window.confirm(`Archive ${offer.code}? Customers will no longer see it at checkout.`)) return;
    if (demo) { setOffers((current) => current.filter((row) => row.id !== offer.id)); setToast(`${offer.code} was archived.`); return; }
    setOfferBusy(offer.id);
    try {
      await api("/api/merchant/offers", { method: "DELETE", body: JSON.stringify({ id: offer.id }) });
      setOffers((current) => current.filter((row) => row.id !== offer.id)); setOffersError(""); setToast(`${offer.code} was archived.`);
    } catch (error) { setToast(error instanceof Error ? error.message : "Could not archive the offer."); }
    finally { setOfferBusy(""); }
  }
  async function addStaff(event: FormEvent) {
    event.preventDefault();
    const email = staffEmail.trim().toLowerCase();
    if (!email) return;
    setStaffBusy("new"); setStaffError("");
    try {
      const data = await api<{ staff: StaffMember }>("/api/merchant/staff", { method: "POST", body: JSON.stringify({ email, role: staffRole }) });
      setStaff((current) => [data.staff, ...current.filter((member) => member.userId !== data.staff.userId)]);
      setStaffEmail(""); setToast(`${email} can now access this outlet as ${ROLE_LABELS[staffRole].toLowerCase()}.`);
    } catch (error) { setStaffError(error instanceof Error ? error.message : "Could not add this person."); }
    finally { setStaffBusy(""); }
  }
  async function changeStaffRole(member: StaffMember, next: StaffRole) {
    if (next === member.role || staffBusy) return;
    setStaffBusy(member.id); setStaffError("");
    try {
      const data = await api<{ staff: StaffMember }>("/api/merchant/staff", { method: "PATCH", body: JSON.stringify({ id: member.id, role: next }) });
      setStaff((current) => current.map((row) => row.id === member.id ? data.staff : row));
      setToast(`${member.email} is now ${ROLE_LABELS[next].toLowerCase()}.`);
    } catch (error) { setStaffError(error instanceof Error ? error.message : "Could not change this role."); }
    finally { setStaffBusy(""); }
  }
  async function removeStaff(member: StaffMember) {
    if (!window.confirm(`Remove ${member.email} from this outlet?`)) return;
    setStaffBusy(member.id); setStaffError("");
    try {
      await api("/api/merchant/staff", { method: "DELETE", body: JSON.stringify({ id: member.id }) });
      setStaff((current) => current.filter((row) => row.id !== member.id));
      setToast(`${member.email} no longer has access.`);
    } catch (error) { setStaffError(error instanceof Error ? error.message : "Could not remove this person."); }
    finally { setStaffBusy(""); }
  }
  function switchDemoMode() { if (!business) return; const next = business.type === "restaurant" ? "vendor" : "restaurant"; setBusiness({ ...business, type: next }); if (page === "more") setPage("home"); setToast(`Exploring ${next === "vendor" ? "street vendor" : "restaurant"} mode with sample data.`); }
  function navigate(next: Page) { setPage(next); if (next === "orders") { setOrderPage(1); setOrderFilter("active"); } window.scrollTo({ top: 0, behavior: "smooth" }); }
  const storeSwitch = <button className={`switch ${business?.isOpen ? "on" : ""}`} role="switch" aria-checked={!!business?.isOpen} aria-label="Store open for orders" disabled={!business || busyStore} onClick={toggleStore}><span /></button>;

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark"><UtensilsCrossed size={20} strokeWidth={2.4} /></span><div><strong>savour<span>.</span></strong><small>PARTNER</small></div></div>
      <div className="sidebar-caption">WORKSPACE</div><nav className="side-nav" aria-label="Main navigation">{visibleNav.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? "active" : ""}`} onClick={() => navigate(id)}><Icon size={19} strokeWidth={page === id ? 2.2 : 1.8} /><span>{label}</span>{id === "orders" && stats.counts.new > 0 && <em>{String(stats.counts.new).padStart(2, "0")}</em>}</button>)}</nav>
      <div className="sidebar-spacer" /><div className="sidebar-help"><div className="help-icon"><Headphones size={19} /></div><strong>Here when you need us</strong><p>Questions about your workspace?</p><button onClick={() => setHelpOpen(true)}>Visit help centre <ArrowRight size={14} /></button></div>
      <div className="sidebar-bottom"><div className="store-avatar">{initials(name)}</div><div className="store-identity"><strong>{name}</strong><span>{vendor ? "Street vendor" : "Restaurant partner"}</span></div><button className="icon-button small" aria-label="Account options" onClick={() => demo ? setAccountOpen(true) : vendor ? setProfileOpen(true) : navigate("more")}><MoreHorizontal size={19} /></button></div>
    </aside>
    <main className="main-area"><header className="topbar"><div className="breadcrumb"><span>Workspace</span><ChevronRight size={15} /><strong>{navItems.find((n) => n.id === page)?.label}</strong></div><div className="topbar-right"><div className="top-search"><Search size={17} /><input aria-label="Search order number" placeholder="Search orders..." value={search} onChange={(e) => { setSearch(e.target.value); setPage("orders"); setOrderFilter("all"); }} /></div><button className="top-notification" aria-label="Notification settings" onClick={() => setNotificationsOpen(true)}><Bell size={19} /><span /></button><div className="top-divider" /><button className="top-store" onClick={() => demo ? setAccountOpen(true) : setProfileOpen(true)}><div className="store-avatar small-avatar">{initials(name)}</div><div><strong>{name}</strong><span>{demo ? "Sample workspace" : user?.email}</span></div><ChevronDown size={15} /></button></div></header>
      <div className="mobile-topbar"><div className="mobile-brand"><span className="brand-mark"><UtensilsCrossed size={18} /></span><strong>savour<span>.</span></strong><small>PARTNER</small></div><div className="mobile-top-actions"><button className="icon-button" aria-label="Notifications" onClick={() => setNotificationsOpen(true)}><Bell size={20} /></button><button className="store-avatar small-avatar avatar-button" aria-label="Account" onClick={() => demo ? setAccountOpen(true) : setProfileOpen(true)}>{initials(name)}</button></div></div>
      {!online && <div className="connection-banner"><WifiOff size={16} /> You’re offline. New orders and changes won’t sync until you reconnect.</div>}
      {online && !demo && linkInvalid && <div className="connection-banner reconnect-banner"><Link2 size={16} /><div><strong>Marketplace connection needs attention.</strong><span>Orders and menu won’t sync until you reconnect. Open Business settings → Marketplace connection and generate a fresh pairing code.</span></div><button onClick={() => navigate("more")}>Open settings</button></div>}
      {online && syncError && !linkInvalid && <div className="connection-banner"><WifiOff size={16} /> {syncError} <button onClick={() => setRefreshKey((n) => n + 1)}>Retry</button></div>}
      {!demo && user && !user.emailVerified && <div className="verification-banner"><Mail size={16} /><div><strong>{verificationRequired ? "Verify your email to continue" : "Email verification is optional for now"}</strong><span>{verificationRequired ? `We sent a link to ${user.email}. Check your inbox and spam folder.` : "Your workspace is ready to use; you can confirm your address whenever delivery is available."}</span></div><button disabled={resendingVerification} onClick={() => void resendVerification()}>{resendingVerification ? "Sending…" : "Resend verification email"}</button></div>}
      {demo && <div className="demo-banner"><div><Sparkles size={15} /><strong>Explore your sample workspace</strong><span>Sample data · changes are temporary</span></div><div><button className="demo-mode-button" onClick={switchDemoMode}>Try {vendor ? "restaurant" : "street vendor"} mode</button><button className="demo-signup" onClick={() => setAccountOpen(true)}>Get started <ArrowRight size={14} /></button></div></div>}
      <div className="content-wrap">
        {page === "home" && <>
          <div className="page-intro home-intro"><div><div className="eyebrow">YOUR BUSINESS AT A GLANCE <span>✳</span></div><h1 suppressHydrationWarning>{greeting()}{business?.ownerName ? `, ${business.ownerName.split(" ")[0]}` : ""} <span className="wave">✦</span></h1><p>Here’s what’s happening at <strong>{name}</strong> today.</p></div><div className="date-chip" suppressHydrationWarning><Clock3 size={16} /> {dateLabel}</div></div>
          {(!business || business.approvalStatus === "draft") && !demo && <div className="setup-banner"><div><strong>Let’s get your business ready.</strong><span>Finish your details and add your first menu item to get started.</span></div><button className="btn btn-primary" onClick={() => setSetupOpen(true)}>Continue setup <ArrowRight size={15} /></button></div>}
          {business?.approvalStatus === "pending" && !demo && <div className="approval-banner"><Info size={18} /><div><strong>Your listing is pending review</strong><span>You can set up your menu while your business awaits approval. It isn’t visible to customers yet.</span></div></div>}
          {vendor && <div className="vendor-store-bar"><div><strong>Your store is {business?.isOpen ? "open" : "closed"}</strong><p>{accepting ? "You’re accepting new orders" : "Not accepting new orders right now"}</p></div>{storeSwitch}</div>}
          <div className={`metrics-grid ${vendor ? "vendor-metrics" : ""}`}><Metric icon={<CircleDollarSign size={21} />} tone="red" title="Today’s sales" value={money(stats.todaySales)} detail="Gross value of completed orders" /><Metric icon={<ShoppingBag size={21} />} tone="blue" title="Total orders" value={String(stats.todayOrders).padStart(2, "0")} detail="Marketplace orders today" /><Metric icon={<BellRing size={21} />} tone="amber" title="New orders" value={String(stats.counts.new).padStart(2, "0")} detail="Waiting for your response" accent={stats.counts.new > 0} />{vendor && <Metric icon={<ChefHat size={21} />} tone="blue" title="Preparing" value={String(stats.counts.accepted + stats.counts.preparing).padStart(2, "0")} detail="Orders in the kitchen" />}<Metric icon={<PackageCheck size={21} />} tone="green" title="Ready for handoff" value={String(stats.counts.ready).padStart(2, "0")} detail="Ready for handoff" /><Metric icon={<Star size={21} />} tone="amber" title="Customer rating" value={stats.feedback.available && stats.feedback.averageRating !== null ? stats.feedback.averageRating.toFixed(1) : "—"} detail={stats.feedback.available ? `${stats.feedback.reviewCount} reviews · last ${stats.feedback.windowDays} days` : "Not published by Marketplace"} /></div>
          <div className={`dashboard-columns ${vendor ? "vendor-dashboard" : ""}`}><section className="live-section"><div className="section-header"><div><div className="title-line"><h2>Live orders</h2><span className="live-indicator"><span /> LIVE</span></div><p>Keep things moving, one order at a time.</p></div><button className="text-link" onClick={() => navigate("orders")}>View all orders <ArrowRight size={16} /></button></div>
            <div className="home-tabs">{([{ id: "all", label: "All active", count: activeCount }, { id: "new", label: "New", count: stats.counts.new }, { id: "preparing", label: "Preparing", count: stats.counts.accepted + stats.counts.preparing }, { id: "ready", label: "Ready", count: stats.counts.ready }, { id: "out_for_delivery", label: "Out", count: stats.counts.out_for_delivery }] as const).map((tab) => <button key={tab.id} onClick={() => setHomeFilter(tab.id)} className={homeFilter === tab.id ? "selected" : ""}>{tab.label} <span>{tab.count}</span></button>)}</div>
            {activeOrders.length ? <div className="order-grid">{activeOrders.map((order) => <OrderCard key={order.id} order={order} onAction={handleOrderAction} onDetails={setDetails} onFulfilmentChange={handleFulfilmentChange} fulfilmentSettings={{ pickup: business?.pickupEnabled ?? true, delivery: business?.deliveryEnabled ?? true }} fulfilmentBusy={fulfilmentBusy === order.id} busy={!!actionBusy[order.id]} />)}</div> : <Empty icon={<ShoppingBag size={25} />} title="All caught up" text="New and active orders will appear here as they come in." />}
          </section>{!vendor && <aside className="dashboard-aside"><div className="panel store-panel"><div className="store-panel-head"><div className="widget-icon"><Store size={19} /></div><span className={`online-badge ${accepting ? "" : "closed"}`}><span />{accepting ? "ONLINE" : "OFFLINE"}</span></div><div className="store-panel-title"><div><h3>Your store is {business?.isOpen ? "open" : "closed"}</h3><p>{accepting ? "You’re accepting new orders" : business?.isOpen && business.hoursEnabled ? "Outside your scheduled hours" : "Not accepting new orders"}</p></div>{storeSwitch}</div><div className="store-panel-line" /><div className="hours-row"><Clock3 size={16} /><div><span>Operating hours</span><strong>{business?.hoursEnabled ? `${business.opensAt} – ${business.closesAt}` : "No schedule set"}</strong></div></div><button className="widget-link" onClick={() => navigate("more")}>Manage store settings <ArrowRight size={15} /></button></div>
            <div className="panel snapshot-panel"><div className="widget-title"><h3>Today’s snapshot</h3><span>SO FAR</span></div><div className="snapshot-row"><span><span className="snapshot-icon blush"><ShoppingBag size={15} /></span> Orders received</span><strong>{stats.todayOrders}</strong></div><div className="snapshot-row"><span><span className="snapshot-icon gold"><ChefHat size={15} /></span> In the kitchen</span><strong>{stats.counts.accepted + stats.counts.preparing}</strong></div><div className="snapshot-row"><span><span className="snapshot-icon mint"><CheckCircle2 size={15} /></span> Completed today</span><strong>{stats.completedToday}</strong></div></div>
            <div className="panel feedback-panel"><div className="widget-title"><h3>Customer feedback</h3><span>{stats.feedback.windowDays} DAYS</span></div>{stats.feedback.available ? <><div className="feedback-score"><Star size={22} fill="currentColor" /><strong>{stats.feedback.averageRating !== null ? stats.feedback.averageRating.toFixed(1) : "—"}</strong><span>average rating</span></div><div className="snapshot-row"><span>Bad orders (2★ or less)</span><strong>{stats.feedback.badOrders}</strong></div><div className="snapshot-row"><span>Awaiting your reply</span><strong>{stats.feedback.pendingReplies}</strong></div><button className="widget-link" onClick={() => { navigate("orders"); setOrderFilter("feedback"); }}>Read reviews <ArrowRight size={15} /></button></> : <p className="feedback-unavailable">Connected listings keep customer feedback in Marketplace. Publish feedback metrics there to see them here.</p>}</div>
            {!vendor && <div className="menu-promo"><span className="promo-label">A LITTLE TIP</span><h3>A great menu<br />goes a long way.</h3><p>Keep your items fresh and ready to order.</p><button onClick={() => navigate("menu")}>Manage menu <ArrowRight size={15} /></button></div>}
          </aside>}</div>
        </>}
        {page === "orders" && <><div className="page-intro"><div><div className="eyebrow">YOUR ORDER BOOK <span>✳</span></div><h1>Orders</h1><p>Everything you need to keep your orders moving.</p></div><button className="btn btn-outline" onClick={() => setRefreshKey((n) => n + 1)}>Refresh orders</button></div><section className="orders-page"><div className="filter-tabs">{filters.map((filter) => <button key={filter.id} className={orderFilter === filter.id ? "selected" : ""} onClick={() => { setOrderFilter(filter.id); setOrderPage(1); }}>{filter.label}{filter.id === "new" && stats.counts.new > 0 && <span>{stats.counts.new}</span>}</button>)}</div><div className="order-tools"><div className="search-field"><Search size={17} /><input placeholder="Search order number" aria-label="Search order number" value={search} onChange={(e) => { setSearch(e.target.value); setPage("orders"); setOrderFilter("all"); }} /></div><div className="date-filters"><label>From <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setOrderPage(1); }} /></label><label>To <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setOrderPage(1); }} /></label></div></div>{filteredOrders.length ? <div className="order-grid orders-full-grid">{filteredOrders.map((order) => <OrderCard key={order.id} order={order} onAction={handleOrderAction} onDetails={setDetails} onFulfilmentChange={handleFulfilmentChange} fulfilmentSettings={{ pickup: business?.pickupEnabled ?? true, delivery: business?.deliveryEnabled ?? true }} fulfilmentBusy={fulfilmentBusy === order.id} busy={!!actionBusy[order.id]} />)}</div> : <Empty icon={<ShoppingBag size={25} />} title="No orders here yet" text="Orders matching this view will show up here." />}{!demo && <div className="pagination"><button className="btn btn-outline" disabled={orderPage <= 1} onClick={() => setOrderPage((n) => n - 1)}><ChevronLeft size={16} /> Previous</button><span>Page {orderPage}</span><button className="btn btn-outline" disabled={!hasMore} onClick={() => setOrderPage((n) => n + 1)}>Next <ChevronRight size={16} /></button></div>}</section></>}
        {page === "reviews" && <>
          <div className="page-intro"><div><div className="eyebrow">WHAT CUSTOMERS ARE SAYING <span>✳</span></div><h1>Reviews</h1><p>{demo ? "Sample feedback from your demo orders." : "Delivered-order feedback from Marketplace, with replies sent back to the customer."}</p></div>{!demo && <button className="btn btn-outline" disabled={reviewsBusy || linkInvalid} onClick={refreshReviews}>{reviewsBusy ? "Refreshing…" : "Refresh reviews"}</button>}</div>
          {reviewsError && <div className="approval-banner"><Info size={18} /> {reviewsError} <button onClick={refreshReviews}>Retry</button></div>}
          {!demo && <div className="approval-banner"><Info size={18} /> Reviews, themes and public ratings are owned by Marketplace. Your reply is written back to the same listing.</div>}
          <div className="metrics-grid reviews-metrics"><Metric icon={<Star size={21} />} tone="amber" title="Average rating" value={reviewInboxForView.summary.averageRating !== null ? reviewInboxForView.summary.averageRating.toFixed(1) : "—"} detail={`Last ${reviewInboxForView.summary.windowDays} days`} /><Metric icon={<ShoppingBag size={21} />} tone="blue" title="Reviews" value={String(reviewInboxForView.summary.reviewCount)} detail="Delivered orders with feedback" /><Metric icon={<Info size={21} />} tone="red" title="Low ratings" value={String(reviewInboxForView.summary.badOrders)} detail="Two stars or fewer" /><Metric icon={<BellRing size={21} />} tone="green" title="Awaiting reply" value={String(reviewInboxForView.summary.pendingReplies)} detail="Reviews without a merchant reply" /></div>
          <div className="reviews-columns"><section className="panel review-themes"><div className="widget-title"><h3>What people mention</h3><span>30 DAYS</span></div>{reviewInboxForView.themes.length ? <div className="review-theme-list">{reviewInboxForView.themes.map((theme) => <div className="review-theme" key={theme.key}><div><strong>{theme.label}</strong><span>{theme.count} mention{theme.count === 1 ? "" : "s"}</span></div><span className="review-theme-score">{theme.averageRating !== null ? `${theme.averageRating.toFixed(1)}★` : "—"}</span></div>)}</div> : <p className="feedback-unavailable">No written themes in the last 30 days yet.</p>}</section>
            <section className="panel review-list-panel"><div className="widget-title"><h3>Latest reviews</h3><span>{reviewInboxForView.reviews.length} SHOWN</span></div>{reviewInboxForView.reviews.length ? <div className="review-list">{reviewInboxForView.reviews.map((review) => <div className="review-row" key={review.orderCode}>
              <div className="review-row-head"><div><strong>Order {review.orderCode.length > 14 ? `${review.orderCode.slice(0, 14)}…` : review.orderCode}</strong><span suppressHydrationWarning>{review.feedbackAt ? new Date(review.feedbackAt).toLocaleDateString("en-IN") : "Date unavailable"}</span></div><span className={`review-stars ${review.rating !== null && review.rating <= 2 ? "negative" : ""}`}>{review.rating !== null ? `${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)}` : "—"}</span></div>
              {review.review ? <p className="review-text">{review.review}</p> : <p className="review-text muted">No written comment.</p>}
              {review.merchantResponse ? <div className="feedback-reply-sent"><strong>Your reply</strong><p>{review.merchantResponse}</p></div> : can(role, "feedback.write") ? <ReviewReply review={review} busy={reviewReplyBusy === review.orderCode} onSend={submitReviewReply} /> : <p className="feedback-unavailable">Awaiting a reply from your team.</p>}
            </div>)}</div> : <Empty icon={<Star size={25} />} title="No reviews yet" text="Feedback from delivered orders will appear here." />}</section></div>
        </>}
        {page === "menu" && <><div className="page-intro"><div><div className="eyebrow">MADE BY YOU <span>✳</span></div><h1>Your menu</h1><p>Good food starts here. Keep your menu up to date.</p></div>{can(role, "menu.write") && <button className="btn btn-primary" onClick={() => setMenuDialog({ item: null })}><Plus size={17} /> Add item</button>}</div><div className="menu-summary"><span><BookOpen size={18} /> <strong>{items.length}</strong> menu items</span><span className="summary-divider" /><span><span className="green-dot" /> {items.filter((i) => i.available).length} available</span><span><span className="grey-dot" /> {items.filter((i) => !i.available).length} sold out</span></div>{menuError && <div className="approval-banner"><Info size={18} /> {menuError} <button onClick={() => { api<{ items: MenuItem[] }>("/api/merchant/menu").then((data) => { setItems(data.items); setMenuError(""); }).catch((error) => setMenuError(error.message)); }}>Retry</button></div>}{items.length ? <div className="panel menu-list"><div className="menu-list-head"><span>ITEM</span><span>CATEGORY</span><span>PRICE</span><span>AVAILABILITY</span><span /></div>{items.map((item) => <div className="menu-row" key={item.id}><div className="menu-item-info">{item.imageUrl ? <Image src={item.imageUrl} alt="" width={50} height={50} unoptimized className="menu-thumb" /> : <div className="menu-thumb menu-placeholder"><UtensilsCrossed size={20} /></div>}<div><strong>{item.name}</strong><span>{item.description || "A favourite from your kitchen"}</span></div></div><div className="menu-category">{item.category}</div><strong className="menu-price">{money(item.price)}</strong><div className="menu-availability">{can(role, "menu.availability") && <button className={`switch small-switch ${item.available ? "on" : ""}`} role="switch" aria-checked={item.available} aria-label={`${item.name} availability`} disabled={busyItem === item.id} onClick={() => toggleItem(item)}><span /></button>}<span>{item.available ? "Available" : "Sold out"}</span></div>{can(role, "menu.write") && <div className="menu-row-actions"><button className="icon-button small" aria-label={`Edit ${item.name}`} onClick={() => setMenuDialog({ item })}><Settings2 size={17} /></button><button className="icon-button small" aria-label={`Archive ${item.name}`} disabled={busyItem === item.id} onClick={() => deleteItem(item)}><Trash2 size={16} /></button></div>}</div>)}</div> : <Empty icon={<BookOpen size={25} />} title="Your menu starts here" text="Add your first item and price so customers know what’s cooking." action={can(role, "menu.write") ? <button className="btn btn-primary" onClick={() => setMenuDialog({ item: null })}><Plus size={16} /> Add your first item</button> : undefined} />}</>}
        {page === "offers" && <>
          <div className="page-intro"><div><div className="eyebrow">MORE REASONS TO ORDER <span>✳</span></div><h1>Offers</h1><p>Create discount codes your customers can use at checkout. Savings are calculated on your menu prices, never guessed by the browser.</p></div>{can(role, "offers.write") && <button className="btn btn-primary" onClick={() => setOfferDialog({ offer: null })}><Plus size={17} /> Create offer</button>}</div>
          {offersError && <div className="approval-banner"><Info size={18} /> {offersError} <button onClick={() => setRefreshKey((n) => n + 1)}>Retry</button></div>}
          {!demo && stats.settlementSync.linked && <div className="approval-banner"><Info size={18} /> This listing is connected to Savour Marketplace. Offers are owned there; your changes are proxied and never stored twice.</div>}
          <div className="offer-summary"><span><BadgePercent size={18} /> <strong>{offers.filter((offer) => !offer.archived && offer.active && isOfferLive(offer)).length}</strong> live offers</span><span className="summary-divider" /><span><strong>{offers.reduce((sum, offer) => sum + offer.redemptions, 0)}</strong> redemptions</span><span className="summary-divider" /><span><strong>{money(offers.reduce((sum, offer) => sum + offer.discountGiven, 0))}</strong> discount given</span></div>
          <div className="filter-tabs offer-tabs"><button className={offerFilter === "active" ? "selected" : ""} onClick={() => setOfferFilter("active")}>Active</button><button className={offerFilter === "archived" ? "selected" : ""} onClick={() => setOfferFilter("archived")}>Archived</button></div>
          {offers.filter((offer) => offerFilter === "archived" ? offer.archived : !offer.archived).length ? (
            <div className="offer-grid">{offers.filter((offer) => offerFilter === "archived" ? offer.archived : !offer.archived).map((offer) => {
              const status = offer.archived ? "Archived" : !offer.active ? "Paused" : !isOfferLive(offer) ? "Scheduled" : "Live";
              return <div className="panel offer-card" key={offer.id}>
                <div className="offer-card-head"><span className="offer-code">{offer.code}</span><span className={`offer-status ${status.toLowerCase()}`}>{status}</span></div>
                <h3>{offer.title}</h3>{offer.description && <p className="offer-description">{offer.description}</p>}
                <div className="offer-value"><strong>{discountLabel(offer)}</strong><span>{offer.minOrder ? `On orders above ${money(offer.minOrder)}` : "No minimum order"}</span></div>
                <div className="offer-detail-row"><span>Used</span><strong>{offer.redemptions}{offer.usageLimit ? ` / ${offer.usageLimit}` : ""}</strong></div>
                <div className="offer-detail-row"><span>Discount given</span><strong>{money(offer.discountGiven)}</strong></div>
                <div className="offer-detail-row"><span>Order value influenced</span><strong>{money(offer.influencedGross)}</strong></div>
                {(offer.startsAt || offer.endsAt) && <div className="offer-schedule" suppressHydrationWarning>{offer.startsAt ? `From ${new Date(offer.startsAt).toLocaleDateString("en-IN")}` : "Starts immediately"}{offer.endsAt ? ` · Until ${new Date(offer.endsAt).toLocaleDateString("en-IN")}` : " · No end date"}</div>}
                <div className="offer-card-actions"><button className="btn btn-outline" onClick={() => setOfferDialog({ offer })}>Edit</button><button className={`switch small-switch ${offer.active && !offer.archived ? "on" : ""}`} role="switch" aria-checked={offer.active && !offer.archived} aria-label={`${offer.code} active`} disabled={!!offerBusy || offer.archived} onClick={() => void toggleOffer(offer)}><span /></button><button className="icon-button small" aria-label={`Archive ${offer.code}`} disabled={!!offerBusy} onClick={() => void archiveOffer(offer)}><Trash2 size={16} /></button></div>
              </div>;
            })}</div>
          ) : <Empty icon={<BadgePercent size={25} />} title={offerFilter === "archived" ? "No archived offers" : "No offers yet"} text={offerFilter === "archived" ? "Archived codes will appear here." : "Create a code to give customers a reason to order."} action={offerFilter === "active" ? <button className="btn btn-primary" onClick={() => setOfferDialog({ offer: null })}>Create your first offer</button> : undefined} />}
        </>}
        {page === "staff" && <>
          <div className="page-intro"><div><div className="eyebrow">YOUR TEAM <span>✳</span></div><h1>Staff access</h1><p>Invite teammates with only the access they need. Permissions are enforced by the server on every action.</p></div><span className="role-chip"><ShieldCheck size={15} /> {ROLE_LABELS[role]}</span></div>
          {staffError && <div className="approval-banner"><Info size={18} /> {staffError}</div>}
          <form className="panel staff-add" onSubmit={(event) => void addStaff(event)}><div><strong>Add a teammate</strong><span>They need a Savour account with this email address.</span></div><input type="email" required placeholder="name@example.com" value={staffEmail} onChange={(event) => setStaffEmail(event.target.value)} disabled={!!staffBusy} /><select aria-label="Staff role" value={staffRole} onChange={(event) => setStaffRole(event.target.value as StaffRole)} disabled={!!staffBusy}>{STAFF_ROLES.map((value) => <option value={value} key={value}>{ROLE_LABELS[value]}</option>)}</select><button className="btn btn-primary" disabled={!!staffBusy || !staffEmail.trim()}>{staffBusy === "new" ? "Adding…" : "Add staff"}</button></form>
          <div className="staff-list panel">{staff.length ? staff.map((member) => <div className="staff-row" key={member.id}><div className="staff-identity"><div className="staff-avatar">{initials(member.email)}</div><div><strong>{member.email}</strong><span>Added {timeAgo(member.createdAt)}</span></div></div><select aria-label={`Role for ${member.email}`} value={member.role} onChange={(event) => void changeStaffRole(member, event.target.value as StaffRole)} disabled={!!staffBusy}>{STAFF_ROLES.map((value) => <option value={value} key={value}>{ROLE_LABELS[value]}</option>)}</select><button className="icon-button small" aria-label={`Remove ${member.email}`} disabled={!!staffBusy} onClick={() => void removeStaff(member)}><Trash2 size={15} /></button></div>) : <Empty icon={<Users size={25} />} title="No staff yet" text="Add a teammate to share the workload." />}</div>
          <div className="staff-guide"><div className="staff-guide-head"><ShieldCheck size={17} /><strong>What each role can do</strong></div><div className="staff-guide-grid">{(["owner", ...STAFF_ROLES] as AppRole[]).map((value) => <div className="staff-guide-card" key={value}><strong>{ROLE_LABELS[value]}</strong><span>{ROLE_DESCRIPTIONS[value]}</span></div>)}</div></div>
        </>}
        {page === "earnings" && <><div className="page-intro"><div><div className="eyebrow">THE BIGGER PICTURE <span>✳</span></div><h1>Earnings</h1><p>A clear view of your marketplace sales and settlements.</p></div><div className="earnings-actions">{!demo && can(role, "settlements.read") && <button className="btn btn-outline" disabled={settlementBusy} onClick={() => void refreshSettlements()}>{settlementBusy ? "Refreshing…" : "Refresh settlements"}</button>}{!demo && can(role, "settlements.read") && <a className="btn btn-outline" href="/api/merchant/exports?type=settlements" download><Download size={16} /> Settlements CSV</a>}<div className="date-chip"><Clock3 size={16} /> {earningsTab === "revenue" ? revenueLabel : "Today"}</div></div></div>
        <div className="earnings-tabs" role="tablist" aria-label="Earnings views"><button role="tab" aria-selected={earningsTab === "overview"} className={earningsTab === "overview" ? "selected" : ""} onClick={() => setEarningsTab("overview")}>Overview</button><button role="tab" aria-selected={earningsTab === "revenue"} className={earningsTab === "revenue" ? "selected" : ""} onClick={() => setEarningsTab("revenue")}>Revenue</button></div>
        {earningsTab === "overview" && <>{!demo && can(role, "settlements.read") && ["error", "throttled", "truncated"].includes(stats.settlementSync.status) && <div className="approval-banner"><Info size={18} /><div><strong>{stats.settlementSync.status === "truncated" ? "Settlement history is capped" : stats.settlementSync.status === "throttled" ? "Settlements were refreshed recently" : "Settlements could not be refreshed"}</strong><span>{stats.settlementSync.message ?? "Showing the last saved records."}</span></div>{stats.settlementSync.canRetry && <button disabled={settlementBusy} onClick={() => void refreshSettlements()}>{settlementBusy ? "Retrying…" : "Retry"}</button>}</div>}<div className="earnings-grid"><Metric icon={<CircleDollarSign size={21} />} tone="red" title="Gross sales today" value={money(stats.todaySales)} detail="Completed order value, before fees" /><Metric icon={<CheckCircle2 size={21} />} tone="green" title="Completed today" value={String(stats.completedToday)} detail="Orders marked completed" /><Metric icon={<CreditCard size={21} />} tone="blue" title="Net deposited" value={paidSettlements.length ? money(settlementTotals.net) : "—"} detail={paidSettlements.length ? "Confirmed in Marketplace settlements" : "No confirmed deposits yet"} /><Metric icon={<ArrowDownRight size={21} />} tone="amber" title="Settlements" value={String(paidSettlements.length).padStart(2, "0")} detail={stats.settlementSync.status === "error" ? "Showing last saved records" : stats.settlementSync.lastSyncedAt ? `Synced ${stats.settlementSync.lastSyncedAt.slice(11, 16)} UTC` : "Awaiting Marketplace payouts"} /></div><div className="earnings-columns"><section className="panel earnings-panel"><div className="section-heading"><div><h3>How earnings work</h3><p>Sales and settlement are not the same thing.</p></div><span className="settings-icon"><CircleDollarSign size={20} /></span></div><div className="earnings-line"><span>Gross completed order value today</span><strong>{money(stats.todaySales)}</strong></div><div className="earnings-line"><span>Settled gross</span><strong>{paidSettlements.length ? money(settlementTotals.gross) : "—"}</strong></div><div className="earnings-line"><span>Marketplace fees & adjustments</span><strong>{paidSettlements.length ? money(settlementTotals.fees + settlementTotals.adjustments) : "—"}</strong></div><div className="earnings-line"><span>Refunds</span><strong>{paidSettlements.length ? money(settlementTotals.refunds) : "—"}</strong></div><div className="earnings-line total"><span>Net deposited</span><strong>{paidSettlements.length ? money(settlementTotals.net) : "Not available"}</strong></div><div className="info-box">{stats.settlementSync.status === "error" ? stats.settlementSync.message : paidSettlements.length ? "Amounts come from authoritative Marketplace settlement records, not estimates." : demo ? "Sample payouts are not included. Connect a Marketplace listing to see real settlements." : "Marketplace will show confirmed deposits here after the first completed order is paid out."}</div></section><section className="panel earnings-panel"><div className="section-heading"><div><h3>Settlement history</h3><p>Net records mirrored from Marketplace payouts.</p></div></div>{stats.settlements.length ? stats.settlements.map((settlement) => <div className="earnings-line" key={settlement.id}><span>#{settlement.orderNumber ?? settlement.marketplaceOrderId} · {settlement.status} · {new Date(settlement.paidAt ?? settlement.createdAt).toISOString().slice(0, 10)}</span><strong>{money(settlement.netAmount)}</strong></div>) : <div className="settlement-empty"><CreditCard size={24} /><strong>No settlement records yet</strong><span>{demo ? "Connect a Marketplace listing to see real payouts." : "Confirmed deposits will appear after Marketplace settles an order."}</span></div>}</section></div></>}
        {earningsTab === "revenue" && <>
          {revenueError && <div className="approval-banner"><Info size={18} /> {revenueError}</div>}
          <div className="revenue-toolbar"><div className="revenue-presets">{REVENUE_PRESETS.map((preset) => <button key={preset.id} className={revenuePreset === preset.id ? "selected" : ""} onClick={() => chooseRevenuePreset(preset.id)}>{preset.label}</button>)}<button className={revenuePreset === "custom" ? "selected" : ""} onClick={() => chooseRevenuePreset("custom")}>Custom</button></div><div className="revenue-custom" suppressHydrationWarning><CalendarDays size={16} /><label>From <input aria-label="Revenue from date" type="date" value={revenueRange.from ?? ""} max={revenueRange.to ?? undefined} onChange={(event) => changeRevenueDate("from", event.target.value)} /></label><span>to</span><label>To <input aria-label="Revenue to date" type="date" value={revenueRange.to ?? ""} min={revenueRange.from ?? undefined} onChange={(event) => changeRevenueDate("to", event.target.value)} /></label></div>{!demo && can(role, "settlements.read") && <a className="btn btn-outline" href={revenueExportHref} download><Download size={16} /> Export CSV</a>}{revenueBusy && !demo && <span className="revenue-updating">Updating…</span>}</div>
          <div className="panel revenue-hero"><div className="revenue-primary"><span>Total revenue</span><strong>{revenueForView ? money(revenueForView.grossSales) : "—"}</strong><small suppressHydrationWarning>{revenueLabel} · gross completed sales, before fees</small></div><div className="revenue-divider" /><div className="revenue-secondary"><span>Net paid</span><strong>{revenueForView ? money(revenueForView.netPaid) : "—"}</strong><small>Confirmed Marketplace deposits in the same period</small></div></div>
          <div className="earnings-grid revenue-stats"><Metric icon={<CheckCircle2 size={21} />} tone="green" title="Completed orders" value={revenueForView ? String(revenueForView.completedOrders) : "—"} detail="Orders completed in this range" /><Metric icon={<CalendarDays size={21} />} tone="blue" title="Average order value" value={revenueForView && revenueForView.completedOrders ? money(Math.round(revenueForView.grossSales / revenueForView.completedOrders)) : "—"} detail="Gross sales ÷ completed orders" /><Metric icon={<CreditCard size={21} />} tone="red" title="Paid settlements" value={revenueForView ? String(revenueForView.paidSettlements).padStart(2, "0") : "—"} detail="Confirmed deposits in this range" /></div>
          <div className="info-box">{demo ? "Demo revenue is calculated from completed sample orders. Connect a Marketplace listing to see real totals." : "Revenue is calculated by Marketplace from completed orders and confirmed payments, not from the settlement records shown in Overview."}</div>
        </>}
      </>}
        {page === "more" && <><div className="page-intro"><div><div className="eyebrow">MAKE IT YOURS <span>✳</span></div><h1>Business settings</h1><p>Manage the details that keep your business running.</p></div>{user && <button className="btn btn-outline" onClick={signOut}><LogOut size={16} /> Sign out</button>}</div>{!can(role, "settings.write") ? <Empty icon={<ShieldCheck size={25} />} title="Read-only access" text={`Your ${ROLE_LABELS[role].toLowerCase()} role cannot change business settings.`} /> : business ? <BusinessSettings key={business.id} business={business} onSave={saveSettings} /> : <Empty icon={<Store size={25} />} title="Finish setting up" text="Add your business details to manage your workspace." action={<button className="btn btn-primary" onClick={() => setSetupOpen(true)}>Continue setup</button>} />}</>}
        <footer className="page-footer"><span>Made for the people behind the plate <span>♥</span></span><span>© Savour Partner</span></footer>
      </div>
    </main>
    <nav className="bottom-nav" aria-label="Mobile navigation">{visibleNav.map(({ id, label, icon: Icon }) => <button key={id} className={page === id ? "active" : ""} onClick={() => navigate(id)}><span><Icon size={21} strokeWidth={page === id ? 2.3 : 1.8} />{id === "orders" && stats.counts.new > 0 && <i />}</span><small>{label}</small></button>)}</nav>
    {toast && <div className="toast" role="status"><Info size={17} /> {toast}<button onClick={() => setToast("")} aria-label="Dismiss"><X size={15} /></button></div>}
    {profileOpen && <Modal title="Your account" subtitle={user?.email} onClose={() => setProfileOpen(false)}><div className="form-stack"><div className="info-box"><strong>{name}</strong><br />{vendor ? "Street vendor" : "Restaurant partner"} · {business?.approvalStatus === "approved" ? "Approved" : "Listing not live"}</div><button className="btn btn-outline full large" onClick={() => { setProfileOpen(false); navigate("more"); }}><Settings2 size={16} /> Business details & hours</button>{user && !user.emailVerified && <button className="btn btn-outline full large" onClick={() => { setProfileOpen(false); void resendVerification(); }}><Mail size={16} /> Resend verification email</button>}<button className="btn btn-outline full large" onClick={() => { setProfileOpen(false); setPasswordOpen(true); }}><KeyRound size={16} /> Change password</button><button className="btn btn-outline full large" onClick={() => { setProfileOpen(false); void signOut(); }}><LogOut size={16} /> Sign out</button><button className="btn btn-outline full large" onClick={() => { setProfileOpen(false); void signOutEverywhere(); }}><LogOut size={16} /> Sign out of all devices</button></div></Modal>}
    {accountOpen && <AccountModal onClose={() => setAccountOpen(false)} onSuccess={activate} />}
    {passwordOpen && <PasswordModal onClose={() => setPasswordOpen(false)} onSuccess={() => { setPasswordOpen(false); setToast("Password changed. Other devices were signed out."); }} />}
    {setupOpen && <SetupModal initial={business && !demo ? business : null} onClose={() => setSetupOpen(false)} onBusiness={(value) => { setBusiness(value); setDemo(false); }} />}
    {menuDialog && <MenuModal item={menuDialog.item} vendor={!!vendor} onClose={() => setMenuDialog(null)} onSave={saveMenu} />}
    {offerDialog && <OfferModal offer={offerDialog.offer} onClose={() => setOfferDialog(null)} onSave={saveOffer} />}
    {decision && <DecisionModal order={decision.order} action={decision.action} onClose={() => setDecision(null)} onConfirm={confirmOrder} />}
    {fulfilmentDialog && <FulfilmentModal order={fulfilmentDialog.order} fulfilment={fulfilmentDialog.fulfilment} onClose={() => setFulfilmentDialog(null)} onConfirm={(addressText) => changeFulfilment(fulfilmentDialog.order, fulfilmentDialog.fulfilment, addressText)} />}
    {details && <Modal title={`Order #${details.orderNumber}`} subtitle={`${statusLabel[details.status]} · ${timeAgo(details.createdAt)}`} onClose={() => setDetails(null)}><div className="detail-meta"><span>{details.fulfilment === "delivery" ? <Bike size={17} /> : <Store size={17} />}{details.fulfilment === "delivery" ? "Delivery" : "Pickup"}</span><span><CreditCard size={17} />{details.paymentStatus === "paid" ? "Paid" : "Payment pending"} · {details.paymentMethod}</span></div>{details.courierStatus && <div className="info-box"><strong>Courier update:</strong> {details.courierStatus.replaceAll("_", " ")}{details.courierTrackingId ? ` · tracking ${details.courierTrackingId}` : ""}</div>}{details.paymentReference && <div className="info-box"><strong>Payment reference:</strong> {details.paymentReference}</div>}<div className="detail-items">{details.items.map((item) => <div key={item.id}><span><b>{item.quantity} ×</b> {item.name}{item.modifiers?.length ? <small className="block muted">{item.modifiers.map((modifier) => `${modifier.quantity > 1 ? `${modifier.quantity} × ` : ""}${modifier.name}`).join(", ")}</small> : null}</span><strong>{money(item.lineTotal ?? item.quantity * item.unitPrice)}</strong></div>)}{details.discount > 0 && <div className="detail-discount"><span>Offer {details.offerCode ? `(${details.offerCode})` : "discount"}</span><strong>−{money(details.discount)}</strong></div>}<div className="detail-total"><span>Order total</span><strong>{money(details.total)}</strong></div></div>{details.deliveryAddress.trim() && <div className="info-box"><strong>{details.fulfilment === "delivery" ? "Delivery address:" : "Customer address:"}</strong> {details.deliveryAddress}</div>}{details.customerNote && <div className="info-box"><strong>Customer note:</strong> {details.customerNote}</div>}{details.prepMinutes && <p className="dialog-copy">Preparation time: {details.prepMinutes} minutes</p>}{details.rejectionReason && <p className="dialog-copy">Cancellation reason: {details.rejectionReason}</p>}{details.rating !== null && <div className="feedback-block"><div className="feedback-head"><strong>Customer review</strong><span className={`feedback-stars ${details.rating <= 2 ? "negative" : ""}`}>{"★".repeat(details.rating)}{"☆".repeat(5 - details.rating)}</span></div>{details.review ? <p className="feedback-review">“{details.review}”</p> : <p className="feedback-review muted">No written comment.</p>}<span className="feedback-date" suppressHydrationWarning>{details.feedbackAt ? `Submitted ${timeAgo(details.feedbackAt)}` : ""}</span>{details.merchantResponse ? <div className="feedback-reply-sent"><strong>Your reply</strong><p>{details.merchantResponse}</p></div> : <FeedbackReply order={details} busy={feedbackBusy === details.id} onSend={submitFeedbackReply} />}</div>}<button className="btn btn-outline full large" onClick={() => setDetails(null)}>Close details</button></Modal>}
    {notificationsOpen && <Modal title="Order notifications" subtitle="Choose how you’d like to hear about new orders." onClose={() => setNotificationsOpen(false)}><div className="notification-setting"><div><strong>Play a sound</strong><p>When a new order is detected in this workspace.</p></div><button className={`switch ${soundEnabled ? "on" : ""}`} role="switch" aria-checked={soundEnabled} onClick={() => { const next = !soundEnabled; setSoundEnabled(next); localStorage.setItem("savour-sound", next ? "on" : "off"); if (next) playAlert(); }}><span /></button></div><div className="notification-setting"><div><strong>Browser notifications</strong><p>Permission: {notificationPermission}. Availability depends on your browser.</p></div><button className="btn btn-outline" onClick={async () => { if (!("Notification" in window)) { setToast("Browser notifications aren’t supported here."); return; } const permission = await Notification.requestPermission(); setNotificationPermission(permission); }}>Enable</button></div><div className="info-box">This web workspace checks for new orders while open. Background or closed-app delivery isn’t guaranteed.</div></Modal>}
    {helpOpen && <Modal title="Here to help" subtitle="A few tips for your workspace." onClose={() => setHelpOpen(false)}><div className="help-content"><p><strong>Getting started</strong><br />Create an account, complete your business details and add your first menu item. Your listing needs approval before it can go live.</p><p><strong>Orders and connectivity</strong><br />Keep this page open and connected to receive order updates. If your connection drops, reconnect and refresh for the latest state.</p><p><strong>Need to preview the marketplace?</strong><br /><Link href="/marketplace">Visit the customer marketplace <ExternalLink size={14} /></Link></p></div></Modal>}
  </div>;
}
function Metric({ icon, tone, title, value, detail, accent = false }: { icon: React.ReactNode; tone: string; title: string; value: string; detail: string; accent?: boolean }) { return <div className="metric-card"><div className="metric-top"><span className={`metric-icon ${tone}`}>{icon}</span><ArrowUpRight size={16} className="metric-arrow" /></div><span className="metric-title">{title}</span><strong className="metric-value">{value}</strong><span className={`metric-detail ${accent ? "accent" : ""}`}>{accent && <span className="tiny-pulse" />}{detail}</span></div>; }
function Empty({ icon, title, text, action }: { icon: React.ReactNode; title: string; text: string; action?: React.ReactNode }) { return <div className="empty-state"><span>{icon}</span><strong>{title}</strong><p>{text}</p>{action}</div>; }
function FeedbackReply({ order, busy, onSend }: { order: Order; busy: boolean; onSend: (order: Order, response: string) => Promise<void> }) {
  const [response, setResponse] = useState("");
  return <form className="feedback-reply" onSubmit={(event) => { event.preventDefault(); if (response.trim() && !busy) { const sent = response.trim(); void onSend(order, sent).then(() => setResponse("")); } }}>
    <label>Reply to this review<textarea maxLength={500} rows={3} required value={response} onChange={(event) => setResponse(event.target.value)} placeholder="Thank them, or explain what happened…" /></label>
    <button className="btn btn-primary" disabled={busy || !response.trim()}>{busy ? "Sending…" : "Send reply"}</button>
  </form>;
}
function ReviewReply({ review, busy, onSend }: { review: Review; busy: boolean; onSend: (review: Review, response: string) => Promise<void> }) {
  const [response, setResponse] = useState("");
  return <form className="feedback-reply" onSubmit={(event) => { event.preventDefault(); if (response.trim() && !busy) { const sent = response.trim(); void onSend(review, sent).then(() => setResponse("")); } }}>
    <label>Reply to this review<textarea maxLength={500} rows={3} required value={response} onChange={(event) => setResponse(event.target.value)} placeholder="Thank them, or explain what happened…" /></label>
    <button className="btn btn-primary" disabled={busy || !response.trim()}>{busy ? "Sending…" : "Send reply"}</button>
  </form>;
}

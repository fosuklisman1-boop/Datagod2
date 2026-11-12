"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"
import { GH_PHONE_RE } from "@/lib/support-validation"
import {
  buildThreadFormData,
  customerTextError,
  postNewThread,
  validateScreenshot,
  type ThreadFormInput,
} from "@/lib/support-client"

/** Shared state and submit for the two "create a complaint" dialogs. */
export function useThreadForm(
  open: boolean,
  onDone: () => void,
  /** When given (the chat page itself), called instead of navigating. */
  onCreated?: (threadId: string) => void | Promise<void>,
) {
  const router = useRouter()
  const [fileKey, setFileKey] = useState(0)
  const [message, setMessage] = useState("")
  const [phone, setPhone] = useState("")
  const [whatsapp, setWhatsapp] = useState("")
  const [image, setImage] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const inFlight = useRef(false)

  // Prefill from the profile each time the dialog opens.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    ;(async () => {
      const { data: auth } = await supabase.auth.getUser()
      if (!auth.user) return
      const { data } = await supabase.from("users").select("phone_number").eq("id", auth.user.id).single()
      const p = (data?.phone_number as string | undefined) ?? ""
      if (!cancelled) {
        setPhone((cur) => cur || p)
        setWhatsapp((cur) => cur || p)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  const pickImage = (file: File | null) => {
    if (!file) return setImage(null)
    const problem = validateScreenshot(file)
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    setImage(file)
  }

  const submit = async (build: Omit<ThreadFormInput, "message" | "phone" | "whatsapp" | "image">, extraText: string[] = []) => {
    if (inFlight.current) return
    const text = message.trim()
    if (text.length < 5) return setError("Please describe the problem (at least 5 characters).")
    if (text.length > 1000) return setError("Please keep the description under 1000 characters.")
    for (const t of [text, ...extraText]) {
      const bad = customerTextError(t)
      if (bad) return setError(bad)
    }
    if (!GH_PHONE_RE.test(phone.trim())) return setError("Enter a valid Ghana phone number, e.g. 0241234567.")
    if (!GH_PHONE_RE.test(whatsapp.trim())) return setError("Enter a valid Ghana WhatsApp number, e.g. 0241234567.")

    inFlight.current = true
    setSubmitting(true)
    setError(null)
    try {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      if (!token) return setError("Please sign in again.")
      const fd = buildThreadFormData({ ...build, message: text, phone: phone.trim(), whatsapp: whatsapp.trim(), image })
      const result = await postNewThread(fd, token)
      if (!result.ok) return setError(result.error)
      if (result.attachmentSaved === false) toast.warning("Complaint sent, but the screenshot could not be saved.")
      else toast.success("Complaint sent. Support will reply here.")
      setMessage("")
      setImage(null)
      setFileKey((k) => k + 1)
      onDone()
      if (onCreated) {
        void Promise.resolve(onCreated(result.threadId)).catch(() => {
          // The complaint was sent; a failed list refresh must not look like a failed send.
        })
      } else {
        router.push(`/dashboard/complaints?thread=${encodeURIComponent(result.threadId)}`)
      }
    } catch {
      setError("Network problem. Please try again.")
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  return { message, setMessage, phone, setPhone, whatsapp, setWhatsapp, image, pickImage, fileKey, error, submitting, submit }
}
